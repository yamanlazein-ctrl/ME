#!/usr/bin/env node
/**
 * Sync-volume generator (specs/002-mobile-app R14, tasks T039).
 *
 * Like scripts/parity/seed-volume.mjs (80% customers / 20% suppliers, one deep customer holding 20% of
 * the invoices, dates over four years, one receipt per invoice) — but every record is sent as a SYNC UNIT
 * through the hub's real `POST /api/sync/push`, in the shape the desktop client builds (syncEnqueue.ts,
 * syncUseCases.ts enqueueInvoiceCreate), by an enrolled test device. The hub materializes each unit, so
 * the data is in the pull stream a fresh phone downloads. Generated data only — no customer data.
 *
 *   E2E_ADMIN_PASSWORD=… node scripts/parity/seed-sync-volume.mjs \
 *     --hub http://127.0.0.1:18080 --invoices 1000 --parties 100 --out seed-1000.json
 *
 * Writes `{ counts, partyBalances }` (per party and currency: invoices − receipts, exact decimal).
 */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const arg = (name, fallback) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : fallback;
};
const HUB = arg("hub", "http://127.0.0.1:18080").replace(/\/$/, "");
const INVOICES = Number(arg("invoices", "1000"));
const PARTIES = Number(arg("parties", "100"));
const OUT = arg("out", "seed-sync-volume.json");
const CONCURRENCY = Number(arg("concurrency", "4"));
const EMAIL = process.env.E2E_ADMIN_EMAIL ?? "admin@erp.local";
const PASSWORD = process.env.E2E_ADMIN_PASSWORD;
// Test hubs whose admin has no known password (the emulator job) pass a minted admin token instead.
const ADMIN_TOKEN = process.env.ADMIN_TOKEN;
if (!PASSWORD && !ADMIN_TOKEN) throw new Error("E2E_ADMIN_PASSWORD or ADMIN_TOKEN is required");
if (!(INVOICES > 0 && PARTIES > 1))
  throw new Error("--invoices > 0 and --parties > 1 are required");

// ── exact decimal helpers (integer cents; half away from zero, like round2dp) ─────────────────
const cents = (n) => BigInt(Math.round(n * 100));
const fmt = (c) => {
  const neg = c < 0n;
  const m = (neg ? -c : c).toString().padStart(3, "0");
  return `${neg ? "-" : ""}${m.slice(0, -2)}.${m.slice(-2)}`;
};
/** qty (1 dp, tenths) × price (2 dp, cents) → cents, rounded half away from zero. */
const mulCents = (qtyTenths, priceCents) => {
  const raw = BigInt(qtyTenths) * BigInt(priceCents); // thousandths
  return (raw + 5n) / 10n;
};

// ── http ────────────────────────────────────────────────────────────────────────────────────
async function http(method, path, body, headers = {}) {
  const res = await fetch(`${HUB}${path}`, {
    method,
    headers: { "content-type": "application/json", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    json = { raw: text };
  }
  return { status: res.status, json };
}

let adminAccessToken = ADMIN_TOKEN;
if (!adminAccessToken) {
  const adminLogin = await http("POST", "/api/auth/login", { email: EMAIL, password: PASSWORD });
  if (adminLogin.status !== 200) throw new Error(`admin login failed: ${adminLogin.status}`);
  adminAccessToken = adminLogin.json.accessToken;
}
const adminAuth = { authorization: `Bearer ${adminAccessToken}` };

const codeRes = await http("POST", "/api/sync/enrollment-code", { maxUses: 5 }, adminAuth);
if (codeRes.status !== 201) throw new Error(`enrollment code failed: ${codeRes.status}`);
const DEVICE_ID = randomUUID();
const enrollBody = {
  code: codeRes.json.current.code,
  device: {
    id: DEVICE_ID,
    fingerprint: `seed-sync-volume-${DEVICE_ID}`,
    platform: "seed",
    hostname: "seed-sync-volume",
  },
};

/** A disposable cert hub has a tenant but no licence row; enrolment needs one. Test hubs only (--pg). */
async function ensureTestLicense(pgUrl) {
  const here = dirname(fileURLToPath(import.meta.url));
  const pg = createRequire(join(here, "../../backend/package.json"))("pg");
  const c = new pg.Client({ connectionString: pgUrl });
  await c.connect();
  try {
    const tenant = (await c.query("SELECT id FROM tenants LIMIT 1")).rows[0];
    const key = "LIC-SEED-VOLUME-0001";
    await c.query(
      `INSERT INTO licenses (key, type, status, max_devices, tenant_id) VALUES ($1, 'perpetual', 'active', 20, $2)
       ON CONFLICT (key) DO NOTHING`,
      [key, tenant.id],
    );
    await c.query("UPDATE tenants SET license_key = $1, license_status = 'active' WHERE id = $2", [
      key,
      tenant.id,
    ]);
  } finally {
    await c.end();
  }
}

let enroll = await http("POST", "/api/sync/enroll", enrollBody);
if (
  enroll.status === 403 &&
  enroll.json?.code === "NO_LICENSE" &&
  arg("pg", process.env.HUB_PG_URL)
) {
  await ensureTestLicense(arg("pg", process.env.HUB_PG_URL));
  const again = await http("POST", "/api/sync/enrollment-code", { maxUses: 5 }, adminAuth);
  enrollBody.code = again.json.current.code;
  enroll = await http("POST", "/api/sync/enroll", enrollBody);
}
if (enroll.status !== 201)
  throw new Error(`enroll failed: ${enroll.status} ${JSON.stringify(enroll.json)}`);
const { tenantId: TENANT_ID, deviceSecret } = enroll.json;
const ACTOR = enroll.json.user;
let token = enroll.json.accessToken;

async function refreshToken() {
  const r = await http("POST", "/api/sync/device-token", {
    tenantId: TENANT_ID,
    deviceId: DEVICE_ID,
    secret: deviceSecret,
  });
  if (r.status !== 200) throw new Error(`device-token failed: ${r.status}`);
  token = r.json.accessToken;
}

async function authed(method, path, body) {
  for (let attempt = 0; attempt < 2; attempt++) {
    const r = await http(method, path, body, {
      authorization: `Bearer ${token}`,
      "x-sync-device-id": DEVICE_ID,
    });
    if (r.status === 401 && attempt === 0) {
      await refreshToken();
      continue;
    }
    return r;
  }
  throw new Error("unreachable");
}

// ── number blocks ───────────────────────────────────────────────────────────────────────────
const blocks = new Map(); // entityType -> { prefix, year, next, end }
const claimLocks = new Map(); // entityType -> promise (one claim at a time per type)
async function nextNumber(entityType) {
  for (;;) {
    const b = blocks.get(entityType);
    if (b && b.next <= b.end) break;
    const pending = claimLocks.get(entityType);
    if (pending) {
      await pending;
      continue;
    }
    const claim = claimBlock(entityType).finally(() => claimLocks.delete(entityType));
    claimLocks.set(entityType, claim);
    await claim;
  }
  const b = blocks.get(entityType);
  const n = b.next++;
  return `${b.prefix}-${b.year}-${String(n).padStart(4, "0")}`;
}
async function claimBlock(entityType) {
  {
    const r = await authed("POST", "/api/sync/number-blocks/claim", {
      syncDeviceId: DEVICE_ID,
      entityType,
      size: 5000,
    });
    if (r.status >= 300)
      throw new Error(`claim ${entityType}: ${r.status} ${JSON.stringify(r.json)}`);
    blocks.set(entityType, {
      prefix: r.json.prefix,
      year: r.json.year,
      next: r.json.startNumber,
      end: r.json.endNumber,
    });
  }
}

// ── units ───────────────────────────────────────────────────────────────────────────────────
const actor = {
  actorUserId: ACTOR.id,
  actorRole: ACTOR.role,
  actorUserName: ACTOR.name,
};

const stats = { sent: 0, applied: 0, other: [] };
async function push(entityType, entityId, operation, payload) {
  const r = await authed("POST", "/api/sync/push", {
    opId: randomUUID(),
    syncDeviceId: DEVICE_ID,
    entityType,
    entityId,
    operation,
    payload: { ...payload, ...actor },
  });
  stats.sent++;
  if (r.status === 201 || r.status === 200) {
    if (r.json.hubStatus === "applied" || r.json.status === "applied") stats.applied++;
    else if (stats.other.length < 10)
      stats.other.push({ entityType, status: r.json.hubStatus, reason: r.json.hubReason });
    if (r.json.hubStatus !== "applied" && r.json.status !== "applied")
      throw new Error(`${entityType} ${operation} not applied: ${JSON.stringify(r.json)}`);
    return r.json;
  }
  throw new Error(
    `${entityType} ${operation}: HTTP ${r.status} ${JSON.stringify(r.json).slice(0, 500)}`,
  );
}

async function inPool(items, worker) {
  let i = 0;
  const run = async () => {
    for (;;) {
      const mine = i++;
      if (mine >= items.length) return;
      await worker(items[mine], mine);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, CONCURRENCY) }, run));
}

// ── data ────────────────────────────────────────────────────────────────────────────────────
let seed = 20261025;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const pick = (n) => Math.floor(rnd() * n);

const fabricId = randomUUID();
const colorId = randomUUID();
const ROLL_COUNT = 5;
const rollIds = Array.from({ length: ROLL_COUNT }, () => randomUUID());
const ENTRY_DATE = "2022-01-01";

console.log(`[seed] hub ${HUB} tenant ${TENANT_ID} device ${DEVICE_ID}`);

await push("fabric", fabricId, "create", {
  snapshot: { id: fabricId, name: "قطن تجريبي", category: "seed", minStockKg: 0, unit: "kg" },
});
await push("color", colorId, "create", {
  snapshot: { id: colorId, fabricId, name: "أبيض", code: "WHT", hex: "#ffffff" },
});
for (const [i, id] of rollIds.entries()) {
  await push("roll", id, "create", {
    snapshot: {
      id,
      colorId,
      rollNo: `SEED-${DEVICE_ID.slice(0, 8)}-${i + 1}`,
      initialKg: 50_000_000,
      remainingKg: 50_000_000,
      pieces: 1,
      remainingPieces: 1,
      pricePerKg: 2,
      currency: "USD",
      entryPricePerKg: 2,
      entryCurrency: "USD",
      entrySource: "stock_in",
      entryDate: ENTRY_DATE,
      status: "in_stock",
    },
  });
}

const customerCount = Math.max(1, Math.round(PARTIES * 0.8));
const parties = [];
for (let i = 0; i < PARTIES; i++) {
  const kind = i < customerCount ? "customer" : "supplier";
  parties.push({
    id: randomUUID(),
    kind,
    name: `${kind === "customer" ? "عميل" : "مورد"} ${i + 1}`,
    currency: i % 10 < 3 ? "SYP" : "USD",
  });
}
await inPool(parties, async (p) => {
  const code = await nextNumber(p.kind);
  await push("party", p.id, "create", {
    snapshot: { ...p, code, status: "active", openingBalance: 0, openingDate: ENTRY_DATE },
  });
});

const customers = parties.filter((p) => p.kind === "customer");
const deep = customers[0];
const balances = new Map(); // `${partyId}|${currency}` -> cents
let sales = 0;
let receipts = 0;

const FOUR_YEARS_DAYS = 4 * 365;
const dateFor = (i) => {
  const d = new Date(Date.UTC(2026, 9, 1));
  d.setUTCDate(d.getUTCDate() - Math.floor((i / INVOICES) * FOUR_YEARS_DAYS));
  return d.toISOString().slice(0, 10);
};

const jobs = Array.from({ length: INVOICES }, (_, i) => {
  const party =
    rnd() < 0.2 ? deep : (customers[1 + pick(Math.max(1, customers.length - 1))] ?? deep);
  const qtyTenths = 10 + pick(490); // 1.0 … 50.9 kg
  const priceCents = party.currency === "SYP" ? 1000000 + pick(500000) * 100 : 100 + pick(1900);
  return { i, party, qtyTenths, priceCents, date: dateFor(i), rollId: rollIds[i % ROLL_COUNT] };
});

await inPool(jobs, async (job) => {
  const { party, qtyTenths, priceCents, date, rollId } = job;
  const rate = party.currency === "SYP" ? 14500 : 1;
  const qty = qtyTenths / 10;
  const price = priceCents / 100;
  const totalCents = mulCents(qtyTenths, priceCents);
  const invoiceId = randomUUID();
  const invoiceNumber = await nextNumber("invoice");
  const createInput = {
    type: "sale",
    date,
    partyId: party.id,
    partyType: "customer",
    currency: party.currency,
    exchangeRate: rate,
    lines: [
      {
        fabricId,
        colorId,
        rollId,
        quantityKg: qty,
        pieces: 0,
        pricePerKg: price,
        discountAmount: 0,
        costPerKg: 2,
      },
    ],
    paid: 0,
  };
  await push("invoice", invoiceId, "create", {
    invoiceId,
    invoiceType: "sale",
    invoiceNumber,
    partyId: party.id,
    rollIds: [rollId],
    lines: [{ rollId, quantityKg: qty, pieces: 0, costPerKg: 2 }],
    createInput,
    dependencies: null,
    preAllocated: true,
  });
  sales++;

  const receiptCents = totalCents / 2n;
  if (receiptCents > 0n) {
    const voucherId = randomUUID();
    const voucherNumber = await nextNumber("voucher");
    await push("voucher", voucherId, "create", {
      voucherId,
      voucherKind: "receipt",
      voucherNumber,
      partyId: party.id,
      createInput: {
        kind: "receipt",
        date,
        partyId: party.id,
        partyKind: "customer",
        amount: Number(fmt(receiptCents)),
        currency: party.currency,
        exchangeRate: rate,
        method: "cash",
      },
      dependencies: null,
      preAllocated: true,
    });
    receipts++;
  }
  const key = `${party.id}|${party.currency}`;
  balances.set(key, (balances.get(key) ?? 0n) + totalCents - receiptCents);
  if ((job.i + 1) % 100 === 0) console.log(`[seed] ${job.i + 1}/${INVOICES} invoices`);
});

const partyBalances = {};
for (const [key, c] of balances) {
  const [partyId, currency] = key.split("|");
  (partyBalances[partyId] ??= {})[currency] = fmt(c);
}
const result = {
  hub: HUB,
  tenantId: TENANT_ID,
  counts: {
    parties: parties.length,
    customers: customers.length,
    invoices: sales,
    receipts,
    unitsSent: stats.sent,
  },
  partyBalances,
};
writeFileSync(OUT, JSON.stringify(result, null, 2));

// ── check against the hub: nothing pending, every party balance equal ──────────────────────
const adminHeaders = ADMIN_TOKEN
  ? adminAuth
  : {
      authorization: `Bearer ${(await http("POST", "/api/auth/login", { email: EMAIL, password: PASSWORD })).json.accessToken}`,
    };
const status = await http("GET", "/api/sync/status", undefined, adminHeaders);
const report = await http("GET", "/api/reports/party-balances", undefined, adminHeaders);
const hubRows = report.json?.data ?? [];
let mismatches = 0;
for (const [partyId, byCurrency] of Object.entries(partyBalances)) {
  for (const [currency, expected] of Object.entries(byCurrency)) {
    const row = hubRows.find((r) => r.partyId === partyId && r.currency === currency);
    if (!row || Number(row.remaining) !== Number(expected)) {
      mismatches++;
      if (mismatches <= 10)
        console.log(`[seed] MISMATCH ${partyId} ${currency}: hub ${row?.remaining} vs ${expected}`);
    }
  }
}
console.log(
  `[seed] hub pendingCount=${status.json?.pendingCount} inbox=${JSON.stringify(status.json?.inboxStatusCounts)} balance mismatches=${mismatches}`,
);
if (mismatches > 0 || status.json?.pendingCount !== 0) process.exitCode = 1;
console.log(`[seed] done: ${JSON.stringify(result.counts)} → ${OUT}`);
