/**
 * VERIFY BATCH B — BUG-05 + BUG-06 (live, isolated :8097). Verification only.
 * Chain: roll(100kg@1000) -> send 30 -> receive 25 @500/kg -> sell all 25 @8000.
 * Manual math: result price=1500 ; COGS=37,500 ; revenue=200,000 ; profit=162,500
 * with print cost deducted EXACTLY ONCE. Data prefix: AUDPB-*.
 */
import pg from "pg";
import { spawn } from "node:child_process";
import fs from "node:fs";

const PORT = "8097";
const BASE = `http://127.0.0.1:${PORT}`;
const TODAY = new Date().toISOString().slice(0, 10);
const NS = "PB" + Date.now().toString(36);

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

// ── setup ──
const cb = data(await api("POST", "/api/customers", { kind: "customer", name: `${NS}-C`, currency: "SYP" }));
const fab = data(await api("POST", "/api/inventory/fabrics", { name: `${NS}-FAB` }));
const k1 = data(await api("POST", "/api/inventory/colors", { fabricId: fab.id, name: `${NS}-K1`, code: "B1" }));
const srcRoll = data(
  await api("POST", "/api/inventory/rolls", {
    colorId: k1.id, rollNo: `${NS}-R1`, initialKg: 100, pricePerKg: 1000, currency: "SYP", entryDate: TODAY, pieces: 40,
  }),
);

// send 30 kg (pieces recorded on the job default to 1; ratio scaling keeps >=1)
const pj = data(
  await api("POST", "/api/printing/send", {
    date: TODAY, sourceRollId: srcRoll.id, quantityKg: 30, pressName: `${NS}-PRESS`,
    newName: `${NS}-PRINTED`, newColorName: `${NS}-KP`, currency: "SYP",
  }),
);
// receive 25 (waste 5) with print cost 500/kg
const pr = data(
  await api("POST", "/api/printing/receive", {
    jobId: pj.id, receivedKg: 25, printCostPerKg: 500, currency: "SYP",
    newName: `${NS}-PRINTED`, newColorName: `${NS}-KP`,
  }),
);
const rpId = pr.resultRollId;

// ── DoD-B1: printed fabric sellable immediately ──
console.log("\n── BUG-05: printed roll sellable ──");
const rpRow = (await q(`select remaining_kg, remaining_pieces, price_per_kg from rolls where id=$1`, [rpId]))[0];
record(
  "B1-a",
  "result roll has sellable pieces (remaining_pieces >= 1)",
  Number(rpRow.remaining_pieces) >= 1,
  `remaining_pieces=${rpRow.remaining_pieces} remaining_kg=${rpRow.remaining_kg}`,
);
const saleRes = await api("POST", "/api/invoices", {
  type: "sale", date: TODAY, partyId: cb.id, partyType: "customer", currency: "SYP", paid: 0,
  lines: [{ fabricId: pr.resultFabricId, colorId: pr.resultColorId, rollId: rpId, quantityKg: 25, pieces: Math.min(2, Number(rpRow.remaining_pieces)), pricePerKg: 8000 }],
});
record("B1-b", "selling the printed roll SUCCEEDS immediately", [200, 201].includes(saleRes.status), `status=${saleRes.status}`);
const sale = data(saleRes);

// ── DoD-B1 checks on cost flow ──
record(
  "B1-c",
  "unit cost = raw 1000 + print 500 = 1500 (cost embedded)",
  Number(rpRow.price_per_kg) === 1500,
  `price_per_kg=${rpRow.price_per_kg}`,
);
const lineCost = (await q(`select cost_per_kg from invoice_lines where invoice_id=$1`, [sale.id]))[0];
record("B1-d", "sold line cost snapshot = 1500", lineCost && Number(lineCost.cost_per_kg) === 1500, `cost_per_kg=${lineCost?.cost_per_kg}`);

// ── BUG-06: print cost counted ONCE ──
console.log("\n── BUG-06: print cost once ──");
const expRows = await q(`select count(*)::int n from expenses where number like $1 and status='active'`, [`EXP-${pj.number}`]);
record("B6-a", "NO separate printing EXPENSE row created anymore", expRows[0].n === 0, `expense rows=${expRows[0].n}`);
const jobLegs = await q(`select type, debit, credit, cash_impact from ledger_entries where reference_type='print_job' and reference_id=$1 order by created_at`, [pj.id]);
const sumD = jobLegs.reduce((s, l) => s + Number(l.debit), 0);
const sumC = jobLegs.reduce((s, l) => s + Number(l.credit), 0);
record(
  "B6-b",
  "capitalization legs balanced: Dr inventory / Cr cash = 12,500",
  sumD === sumC && sumD === 12500 && jobLegs.some((l) => l.type === "inventory_asset") && jobLegs.some((l) => l.type === "cash" && l.cash_impact === "out"),
  `types=[${jobLegs.map((l) => l.type).join(",")}] ΣD=${sumD} ΣC=${sumC}`,
);

// journaled COGS for the sale includes print cost exactly once
const cogsLegs = await q(`select debit from ledger_entries where reference_type='sales_invoice' and reference_id=$1 and type='cogs_expense'`, [sale.id]);
const s3Cogs = cogsLegs.reduce((s, l) => s + Number(l.debit), 0);
record("B6-c", "journaled COGS = 25x1500 = 37,500", s3Cogs === 37500, `cogs=${s3Cogs}`);

// profit line math: revenue 200,000 - cogs 37,500 = 162,500 (print cost ONCE)
const profDet = await api("GET", "/api/profit/details?fromDate=" + TODAY + "&toDate=" + TODAY);
const detLines = profDet.json?.data?.invoiceLines ?? profDet.json?.invoiceLines ?? [];
const sl = detLines.find((l) => l.invoiceId === sale.id);
record(
  "B6-d",
  "profit line = revenue 200,000 / cogs 37,500 (print cost ONCE)",
  Boolean(sl) && Math.abs(sl.revenue - 200000) < 1e-6 && Math.abs(sl.cogs - 37500) < 1e-6,
  `revenue=${sl?.revenue} cogs=${sl?.cogs} expected 200000/37500`,
);
const profExps = profDet.json?.data?.expenses ?? profDet.json?.expenses ?? [];
const dupExp = profExps.filter((e) => e.category === "طباعة" && String(e.description || "").includes(pj.number));
record("B6-e", "no duplicate طباعة expense in profit report for this job", dupExp.length === 0, `matches=${dupExp.length}`);

// ── waste still documented ──
const wasteMv = await q(`select quantity_kg from stock_movements where movement_type='print_waste' and reference_id=$1`, [pj.id]);
record("B-extra", "waste 5kg documented", wasteMv.length >= 1 && Number(wasteMv[0].quantity_kg) === 5, JSON.stringify(wasteMv));

// ── NEGATIVE tests ──
const overReceive = await api("POST", "/api/printing/send", { date: TODAY, sourceRollId: srcRoll.id, quantityKg: 5, pressName: `${NS}-P2`, currency: "SYP" });
const job2 = data(overReceive);
const negRecv = job2?.id ? await api("POST", "/api/printing/receive", { jobId: job2.id, receivedKg: 35, currency: "SYP" }) : { status: "SKIP" };
record("Neg-B1", "NEGATIVE: receiving more than sent REJECTED", ![200, 201].includes(negRecv.status), `status=${negRecv.status}`);

// ════ SUMMARY ════
const fails = results.filter((r) => !r.pass);
console.log(`\n════ BATCH B SUMMARY: TOTAL=${results.length} PASS=${results.length - fails.length} FAIL=${fails.length}`);
fs.writeFileSync(new URL("./verify-batchB-result.json", import.meta.url), JSON.stringify(results, null, 2));
pgc.end();
server.kill();
process.exit(fails.length > 0 ? 2 : 0);

