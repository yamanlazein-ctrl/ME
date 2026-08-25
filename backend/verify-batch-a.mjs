/**
 * VERIFY BATCH A — BUG-03 / BUG-01 / BUG-02 / BUG-04 (live, isolated :8096)
 * Implements the Definition of Done checks + negative tests. Verification only.
 * Data prefix: AUDFX-*.
 */
import pg from "pg";
import { spawn } from "node:child_process";
import fs from "node:fs";

const PORT = "8096";
const BASE = `http://127.0.0.1:${PORT}`;
const TODAY = new Date().toISOString().slice(0, 10);
const NS = "FX" + Date.now().toString(36);

const envFile = fs.readFileSync(new URL("./.env", import.meta.url), "utf8");
const envVar = (k) => {
  const m = envFile.match(new RegExp(`^${k}=(.*)$`, "m"));
  return m ? m[1].trim() : undefined;
};
const DB = envVar("DATABASE_URL");
const ADMINPW = envVar("ADMIN_PASSWORD");

const env = {
  ...process.env,
  NODE_ENV: "test",
  PORT,
  DATABASE_URL: DB,
  JWT_SECRET: "test-secret-32-chars-minimum-padding-padding",
  JWT_EXPIRY_MS: "1800000",
  REFRESH_TOKEN_EXPIRY_MS: "2592000000",
  CORS_ORIGIN: "http://localhost:5173",
  RATE_LIMIT_RPS: "100000",
  RATE_LIMIT_WINDOW_MS: "60000",
  LOG_LEVEL: "error",
  LICENSE_SERVER_MODE: "embedded",
  APP_MASTER_KEY: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=",
};
const server = spawn("npx tsx src/presentation/server.ts", { env, shell: true, stdio: "ignore" });
let healthy = false;
for (let i = 0; i < 40 && !healthy; i++) {
  await new Promise((r) => setTimeout(r, 1500));
  if (server.exitCode !== null) break;
  try {
    const r = await fetch(`${BASE}/api/health/live`);
    healthy = r.ok;
  } catch {}
}
if (!healthy) {
  console.error("SERVER FAILED TO BOOT");
  server.kill();
  process.exit(1);
}
console.log("server up");

const pgc = new pg.Client({ connectionString: DB });
await pgc.connect();
const q = async (sql, params = []) => (await pgc.query(sql, params)).rows;

const tenantId = (await q(`select id from tenants order by created_at limit 1`))[0].id;
const login = await fetch(`${BASE}/api/auth/login`, {
  method: "POST",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ email: "admin@erp.local", password: ADMINPW, tenantId }),
});
const TOKEN = (await login.json()).accessToken;
if (!TOKEN) {
  console.error("LOGIN FAILED");
  server.kill();
  process.exit(1);
}

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, "Content-Type": "application/json" },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = text;
  }
  if (![200, 201].includes(res.status)) console.log(`  [${res.status}] ${method} ${path} ${text.slice(0, 110)}`);
  return { status: res.status, json };
}
const data = (r) => r.json?.data ?? r.json;

const results = [];
function record(id, name, pass, detail = "") {
  results.push({ id, name, pass, detail });
  console.log(`${pass ? "PASS" : "FAIL"} [${id}] ${name}${detail ? " — " + detail : ""}`);
}

async function legBalance(refId) {
  const legs = await q(
    `select type, debit, credit, currency, exchange_rate, base_debit, base_credit, party_id
     from ledger_entries where reference_id=$1 order by created_at`,
    [refId],
  );
  let d = 0,
    c = 0;
  for (const l of legs) {
    d += Number(l.debit);
    c += Number(l.credit);
  }
  return { legs, sumDebit: d, sumCredit: c };
}
async function partyBalance(partyId) {
  // Uniform convention (migration 0012): balance = credits − debits on party legs
  const r = await q(
    `select COALESCE(SUM(credit),0)::float8 - COALESCE(SUM(debit),0)::float8 as bal
     from ledger_entries where tenant_id=$1 and party_id=$2 and status='active'`,
    [tenantId, partyId],
  );
  return Number(r[0].bal);
}
// ════ SETUP ════
const sup = data(await api("POST", "/api/suppliers", { kind: "supplier", name: `${NS}-SUP`, currency: "SYP" }));
const ca = data(await api("POST", "/api/customers", { kind: "customer", name: `${NS}-CA`, currency: "SYP" }));
const fab = data(await api("POST", "/api/inventory/fabrics", { name: `${NS}-FAB` }));
const k1 = data(await api("POST", "/api/inventory/colors", { fabricId: fab.id, name: `${NS}-K1`, code: "F1" }));
const mkRoll = async (rollNo, kg, price, cur) =>
  data(
    await api("POST", "/api/inventory/rolls", {
      colorId: k1.id, rollNo, initialKg: kg, pricePerKg: price, currency: cur, entryDate: TODAY, pieces: Math.ceil(kg),
    }),
  );
const rSyp = await mkRoll(`${NS}-R1`, 200, 1000, "SYP");
const rUsd = await mkRoll(`${NS}-R2`, 50, 2, "USD");

// ════ DoD-1: new invoices store FX ════
console.log("\n── DoD-1: invoice FX capture ──");
const usdInv = data(
  await api("POST", "/api/invoices", {
    type: "sale", date: TODAY, partyId: ca.id, partyType: "customer", currency: "USD", paid: 0,
    lines: [{ fabricId: fab.id, colorId: k1.id, rollId: rUsd.id, quantityKg: 20, pieces: 4, pricePerKg: 5 }],
  }),
);
const usdRow = (await q(`select currency, total, exchange_rate, base_total from invoices where id=$1`, [usdInv.id]))[0];
record(
  "DoD1-a",
  "new USD invoice stores exchange_rate=1 and base_total=total (non-NULL)",
  Number(usdRow.exchange_rate) === 1 && Math.abs(Number(usdRow.base_total) - 100) < 1e-9,
  `exchange_rate=${usdRow.exchange_rate} base_total=${usdRow.base_total} (total=100 USD)`,
);

const RATE = 13500;
const sypInv = data(
  await api("POST", "/api/invoices", {
    type: "sale", date: TODAY, partyId: ca.id, partyType: "customer", currency: "SYP", paid: 0, exchangeRate: RATE,
    lines: [{ fabricId: fab.id, colorId: k1.id, rollId: rSyp.id, quantityKg: 40, pieces: 8, pricePerKg: 5000 }],
  }),
);
const sypRow = (await q(`select exchange_rate, base_total from invoices where id=$1`, [sypInv.id]))[0];
const expBase = Math.round((200000 / RATE) * 100) / 100;
record(
  "DoD1-b",
  `new SYP invoice with exchangeRate=${RATE} freezes rate + computes base`,
  Number(sypRow.exchange_rate) === RATE && Math.abs(Number(sypRow.base_total) - expBase) < 0.01,
  `exchange_rate=${sypRow.exchange_rate} base_total=${sypRow.base_total} (expected ${expBase})`,
);

const invLegs = await q(`select distinct exchange_rate from ledger_entries where reference_id=$1`, [usdInv.id]);
record("DoD1-c", "invoice ledger legs stamped with frozen rate", invLegs.length === 1 && Number(invLegs[0].exchange_rate) === 1, JSON.stringify(invLegs));
// ════ DoD-2+3: returns write REAL balanced ledger entries ════
console.log("\n── DoD-2/3: return ledger entries exist & balanced ──");
const ret1 = data(
  await api("POST", "/api/returns", {
    kind: "sale", date: TODAY, partyId: ca.id, originalInvoiceId: sypInv.id, reason: "defect", currency: "SYP",
    lines: [{ rollId: rSyp.id, quantityKg: 10, pieces: 2, pricePerKg: 5000 }],
  }),
);
// Manual: Cr party 50,000 ; Dr sales_return_contra 50,000 ; Dr inventory 10,000 ; Cr COGS 10,000
const bal1 = await legBalance(ret1.id);
record("DoD2-a", "sale return writes ACTUAL ledger rows (BUG-01 fixed)", bal1.legs.length === 4, `legs=${bal1.legs.length} types=[${bal1.legs.map((l) => l.type).sort().join(",")}]`);
record("DoD3-a", "sale return group BALANCED (Σdebit=Σcredit=60,000)", bal1.sumDebit === bal1.sumCredit && bal1.sumDebit === 60000, `ΣD=${bal1.sumDebit} ΣC=${bal1.sumCredit}`);
const retFxRow = (await q(`select exchange_rate from returns where id=$1`, [ret1.id]))[0];
record("DoD2-b", "return row persists frozen FX from ORIGINAL invoice", Number(retFxRow.exchange_rate) === RATE, `exchange_rate=${retFxRow.exchange_rate}`);
const retRates = [...new Set(bal1.legs.map((l) => Number(l.exchange_rate)))];
record(
  "DoD3-b",
  "return legs use ORIGINAL frozen rate (13500), not current/null",
  retRates.length === 1 && retRates[0] === RATE && bal1.legs.every((l) => l.base_debit !== null),
  `rates=[${retRates}]`,
);

// customer balance dropped by exactly the returned amount (manual: −200k then +50k credit → −150k)
const caBal = await partyBalance(ca.id);
record("DoD2-c", "customer party balance decreased by exactly 50,000 (incl. 100 USD invoice credit)", Math.abs(caBal - (-150100)) < 1e-6, `balance=${caBal} expected=-150100`);

// negative test: excess return rejected
const badRet = await api("POST", "/api/returns", {
  kind: "sale", date: TODAY, partyId: ca.id, originalInvoiceId: sypInv.id, reason: "other", currency: "SYP",
  lines: [{ rollId: rSyp.id, quantityKg: 999, pieces: 1, pricePerKg: 5000 }],
});
record("Neg-A1", "NEGATIVE: return exceeding sold quantity REJECTED", ![200, 201].includes(badRet.status), `status=${badRet.status}`);

// ════ DoD-4: supplier walk — entry return direction (5 manual cases) ════
console.log("\n── DoD-4: supplier balance walk ──");
let bal = await partyBalance(sup.id);
const assertStep = async (label, expected) => {
  bal = await partyBalance(sup.id);
  record("DoD4", label, Math.abs(bal - expected) < 1e-6, `balance=${bal} expected=${expected}`);
};
await api("POST", "/api/invoices", {
  type: "entry", date: TODAY, partyId: sup.id, partyType: "supplier", currency: "SYP", paid: 0,
  lines: [{ fabricId: fab.id, colorId: k1.id, rollId: rSyp.id, quantityKg: 10, pieces: 2, pricePerKg: 10000 }],
});
await assertStep("case1 purchase 100,000 → debt +100,000", 100000);

const entRet = data(
  await api("POST", "/api/returns", {
    kind: "entry", date: TODAY, partyId: sup.id, reason: "wrong_quantity", currency: "SYP",
    lines: [{ rollId: rSyp.id, quantityKg: 2, pieces: 1, pricePerKg: 10000 }],
  }),
);
const balEnt = await legBalance(entRet.id);
record(
  "DoD4-entry-legs",
  "entry return: party leg DEBIT (direction fixed) and balanced",
  Boolean(balEnt.legs.find((l) => l.party_id === sup.id && Number(l.debit) === 20000)) && balEnt.sumDebit === balEnt.sumCredit,
  `types=[${balEnt.legs.map((l) => l.type).join(",")}] ΣD=${balEnt.sumDebit} ΣC=${balEnt.sumCredit}`,
);
await assertStep("case2 purchase return 20,000 → debt 80,000 (DECREASED)", 80000);

const payRes = await api("POST", "/api/payments", {
  date: TODAY, partyId: sup.id, kind: "payment", partyKind: "supplier", amount: 30000, currency: "SYP", method: "cash",
});
await assertStep("case3 supplier payment 30,000 → debt 50,000", 50000);

await api("POST", "/api/invoices", {
  type: "entry", date: TODAY, partyId: sup.id, partyType: "supplier", currency: "SYP", paid: 0,
  lines: [{ fabricId: fab.id, colorId: k1.id, rollId: rSyp.id, quantityKg: 7, pieces: 1, pricePerKg: 10000 }],
});
await assertStep("case4 second purchase 70,000 → debt 120,000", 120000);

await api("POST", "/api/returns", {
  kind: "entry", date: TODAY, partyId: sup.id, reason: "wrong_order", currency: "SYP",
  lines: [{ rollId: rSyp.id, quantityKg: 12, pieces: 1, pricePerKg: 10000 }],
});
await assertStep("case5 full purchase return 120,000 → debt 0", 0);
// ════ DoD-5: profit report reflects the return ════
console.log("\n── DoD-5: profit after return ──");
const profDet = await api("GET", "/api/profit/details?fromDate=" + TODAY + "&toDate=" + TODAY);
const detLines = profDet.json?.data?.invoiceLines ?? profDet.json?.invoiceLines ?? [];
const s1p = detLines.find((l) => l.invoiceId === sypInv.id);
// Manual: revenue 200,000−50,000=150,000 ; cogs 40,000−10,000=30,000
record(
  "DoD5",
  "profit line reflects return: BOTH revenue AND cogs reduced",
  Boolean(s1p) && Math.abs(s1p.revenue - 150000) < 1e-6 && Math.abs(s1p.cogs - 30000) < 1e-6,
  `revenue=${s1p?.revenue} cogs=${s1p?.cogs} (expected 150000/30000)`,
);

// ════ DoD-3c: ≥10 fresh returns all balanced ════
console.log("\n── DoD-3c: sample of 10 fresh returns ──");
let balancedCount = 0;
for (let i = 1; i <= 10; i++) {
  const rr = data(
    await api("POST", "/api/returns", {
      kind: "sale", date: TODAY, partyId: ca.id, originalInvoiceId: sypInv.id, reason: "defect", currency: "SYP",
      lines: [{ rollId: rSyp.id, quantityKg: 1, pieces: 1, pricePerKg: 5000 }],
    }),
  );
  if (!rr?.id) continue;
  const b = await legBalance(rr.id);
  if (b.sumDebit === b.sumCredit && b.legs.length >= 4) balancedCount++;
}
record("DoD3-c", "10/10 fresh returns produce balanced groups", balancedCount === 10, `balanced=${balancedCount}/10`);

// ════ SUMMARY ════
const fails = results.filter((r) => !r.pass);
console.log(`\n════ BATCH A SUMMARY: TOTAL=${results.length} PASS=${results.length - fails.length} FAIL=${fails.length}`);
fs.writeFileSync(new URL("./verify-batchA-result.json", import.meta.url), JSON.stringify(results, null, 2));

pgc.end();
server.kill();
process.exit(fails.length > 0 ? 2 : 0);



