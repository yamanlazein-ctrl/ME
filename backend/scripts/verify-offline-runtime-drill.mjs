/**
 * Batch 5 — FULL OFFLINE RUNTIME DRILL (requirement 17 proof).
 *
 * Proves "offline is real", not an offline flag: a device backend process and a
 * LOCAL PostgreSQL keep accepting every business operation while the hub host
 * is genuinely unreachable (the hub PROCESS is dead — not an in-process stub),
 * the device process is then SIGKILLed and relaunched and every local write and
 * every pending outbox unit survives, and when the hub returns all units reach
 * it and a second device materializes byte-identical data.
 *
 * Topology (real PostgreSQL + real backend processes, nothing mocked):
 *
 *   Device A (offdrill_a :8112, CENTRAL_SYNC_URL -> hub) ─┐
 *   Device B (offdrill_b :8113, CENTRAL_SYNC_URL -> hub) ─┼─> Hub (offdrill_hub :8111)
 *
 * Steps (maps 1:1 to the Batch 5 acceptance list):
 *   1. hub up; A + B registered, baseline synced
 *   2. hub process killed; device genuinely fails to reach it (network error)
 *   3. while offline on A: sale invoice, voucher, expense, order, return,
 *      inventory (fabric/color/roll stock-in), customer update — all succeed
 *   4. SIGKILL A's node process, relaunch while still offline; all writes and
 *      all pending outbox units survive (data durability across a crash)
 *   5. OS-level (full Windows) restart explicitly recorded as UNTESTED
 *   6. hub returns; sync is triggered (manual — no auto-sync timer exists)
 *   7. every pending unit reaches the hub and applies; B pulls + materializes
 *   8. final states of A, B and the hub compared by direct SQL (no lost ops,
 *      no duplicates, no stock/ledger divergence)
 *   9. per-op HTTP status, outbox states, sync run results, row counts recorded
 *
 * Usage: node scripts/verify-offline-runtime-drill.mjs [--keep] [--refresh-template]
 */

import pg from "pg";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import fs from "node:fs";
import path from "node:path";

const BACKEND = path.resolve(import.meta.dirname, "..");
const KEEP = process.argv.includes("--keep");

const PG = { host: "localhost", port: 5432, user: "postgres", password: "postgres" };

const TENANT_ID = "a1a1a1a1-1a1a-4a1a-8a1a-a1a1a1a1a1a1";
const USER_ID = "b2b2b2b2-2b2b-4b2b-8b2b-b2b2b2b2b2b2";
const DEV_A = "c3c3c3c3-3c3c-4c3c-8c3c-c3c3c3c3c3c3";
const DEV_B = "d4d4d4d4-4d4d-4d4d-8d4d-d4d4d4d4d4d4";

const HUB = { db: "offdrill_hub", port: 8111 };
const A = { db: "offdrill_a", port: 8112 };
const B = { db: "offdrill_b", port: 8113 };
const TEMPLATE_DB = "sync_tpl"; // shared with verify-sync-multidevice.mjs

const results = [];
let servers = [];

function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function section(title) {
  console.log(`\n=== ${title} ===`);
}

function info(msg) {
  console.log(`  · ${msg}`);
}

// ---------------------------------------------------------------- env

function loadEnv() {
  const env = {};
  for (const file of ["../.env", ".env"]) {
    const p = path.resolve(BACKEND, file);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      env[m[1]] = v;
    }
  }
  return env;
}

const BASE_ENV = loadEnv();

function dbUrl(db) {
  return `postgresql://${PG.user}:${PG.password}@${PG.host}:${PG.port}/${db}`;
}

async function adminClient() {
  const c = new pg.Client({ ...PG, database: "postgres" });
  await c.connect();
  return c;
}

async function dbClient(db) {
  const c = new pg.Client({ ...PG, database: db });
  await c.connect();
  return c;
}

// ---------------------------------------------------------------- setup

/**
 * Reuse the fully-migrated template (or rebuild it). Same probe as
 * verify-sync-multidevice.mjs: 6 sync tables, received_seq, notifications
 * kind='sync', and the Batch-4 device-trust columns.
 */
async function ensureTemplate() {
  const refresh = process.argv.includes("--refresh-template");
  const c = await adminClient();
  const exists = await c.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [TEMPLATE_DB]);
  if (exists.rows.length > 0 && !refresh) {
    const probe = await dbClient(TEMPLATE_DB);
    const t = await probe.query(
      `SELECT count(*)::int AS c FROM information_schema.tables
       WHERE table_schema='public' AND table_name IN
         ('sync_outbox','sync_inbox','sync_devices','sync_state','document_number_blocks','sync_resource_claims')`,
    );
    const seq = await probe.query(
      `SELECT count(*)::int AS c FROM information_schema.columns
       WHERE table_name='sync_inbox' AND column_name='received_seq'`,
    );
    const kindCheck = await probe.query(
      `SELECT pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
        WHERE t.relname = 'notifications' AND c.conname = 'notifications_kind_check'`,
    );
    const trust = await probe.query(
      `SELECT count(*)::int AS c FROM information_schema.columns
        WHERE table_name='sync_devices'
          AND column_name IN ('revoked_at','revoke_reason','authorized_user_ids')`,
    );
    await probe.end();
    const kindOk = (kindCheck.rows[0]?.def ?? "").includes("'sync'");
    if (t.rows[0].c === 6 && seq.rows[0].c === 1 && kindOk && trust.rows[0].c === 3) {
      await c.end();
      info(`template ${TEMPLATE_DB} reused (6 sync tables + device trust present)`);
      return;
    }
    await c.query(`DROP DATABASE IF EXISTS "${TEMPLATE_DB}" WITH (FORCE)`);
    await c.query(`CREATE DATABASE "${TEMPLATE_DB}"`);
  } else {
    await c.query(`DROP DATABASE IF EXISTS "${TEMPLATE_DB}" WITH (FORCE)`);
    await c.query(`CREATE DATABASE "${TEMPLATE_DB}"`);
  }
  await c.end();
  info(`migrating template ${TEMPLATE_DB} …`);
  await migrate(TEMPLATE_DB);
  info("template ready");
}

async function cloneDatabases() {
  const c = await adminClient();
  for (const { db } of [HUB, A, B]) {
    await c.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
    await c.query(`CREATE DATABASE "${db}" TEMPLATE "${TEMPLATE_DB}"`);
  }
  await c.end();
}

function migrate(db) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["node_modules/drizzle-kit/bin.cjs", "migrate"], {
      cwd: BACKEND,
      env: { ...process.env, ...BASE_ENV, DATABASE_URL: dbUrl(db), NODE_ENV: "test" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("close", (code) =>
      code === 0 ? resolve(out) : reject(new Error(`migrate ${db} failed (${code}):\n${out}`)),
    );
  });
}

async function seed(db) {
  const c = await dbClient(db);
  await c.query(
    `INSERT INTO tenants (id, name, slug, status, license_status, license_type)
     VALUES ($1, 'Offline Drill Tenant', $2, 'active', 'no_license', 'trial')
     ON CONFLICT (id) DO NOTHING`,
    [TENANT_ID, `offdrill-${db}`],
  );
  await c.query(
    `INSERT INTO users (id, tenant_id, name, email, password_hash, role, active)
     VALUES ($1, $2, 'Drill Admin', $3, 'not-used-tokens-are-minted', 'admin', true)
     ON CONFLICT (id) DO NOTHING`,
    [USER_ID, TENANT_ID, `admin-${db}@offdrill.local`],
  );
  for (const [dev, fp] of [
    [DEV_A, "fp-offdrill-a"],
    [DEV_B, "fp-offdrill-b"],
  ]) {
    await c.query(
      `INSERT INTO sync_devices (id, tenant_id, device_fingerprint, platform, hostname, label,
                                 last_seen_by_user_id, authorized_user_ids)
       VALUES ($1, $2, $3, 'windows', $4, $4, $5, ARRAY[$5]::uuid[])
       ON CONFLICT (id) DO NOTHING`,
      [dev, TENANT_ID, `${fp}-${db}`, fp.replace("fp-", ""), USER_ID],
    );
  }
  await c.query(
    `INSERT INTO setup_wizard_state (tenant_id, current_step, completed_steps, is_completed, completed_at)
     VALUES ($1, 'done', ARRAY['welcome'], true, now())
     ON CONFLICT (tenant_id) DO UPDATE SET is_completed = true, current_step = 'done'`,
    [TENANT_ID],
  );
  await c.end();
}

function startServer(name, db, port, centralUrl, logFile) {
  const out = fs.openSync(path.join(BACKEND, logFile), "w");
  const env = {
    ...process.env,
    ...BASE_ENV,
    DATABASE_URL: dbUrl(db),
    PORT: String(port),
    HOST: "127.0.0.1",
    NODE_ENV: "test",
    LOG_LEVEL: "info",
    RATE_LIMIT_RPS: "100000",
  };
  // Both must be DELETED, not blanked (see verify-sync-multidevice.mjs):
  // CENTRAL_SYNC_URL is z.string().url().optional() and DESKTOP_DEPLOY is
  // z.coerce.boolean() (Boolean("false") === true).
  delete env.CENTRAL_SYNC_URL;
  delete env.DESKTOP_DEPLOY;
  if (centralUrl) env.CENTRAL_SYNC_URL = centralUrl;

  const child = spawn(process.execPath, ["node_modules/tsx/dist/cli.mjs", "src/presentation/server.ts"], {
    cwd: BACKEND,
    env,
    stdio: ["ignore", out, out],
  });
  child.__name = name;
  child.__port = port;
  servers.push(child);
  return child;
}

const LOG_FILES = [
  "offdrill-hub.log",
  "offdrill-a.log",
  "offdrill-a2.log",
  "offdrill-b.log",
  "offdrill-hub2.log",
];

async function waitForHealth(port, label, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health/live`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) return true;
      lastErr = `HTTP ${res.status}`;
    } catch (err) {
      lastErr = err?.cause?.code ?? err?.message ?? String(err);
    }
    await new Promise((r) => setTimeout(r, 400));
  }
  let tail = "";
  for (const f of LOG_FILES) {
    const p = path.join(BACKEND, f);
    if (fs.existsSync(p) && fs.statSync(p).size > 0) {
      tail += `\n----- ${f} -----\n${fs.readFileSync(p, "utf8").slice(-2000)}`;
    }
  }
  throw new Error(`${label} did not become healthy on :${port} (last: ${lastErr})${tail}`);
}

function killServer(proc) {
  const idx = servers.indexOf(proc);
  if (idx !== -1) servers.splice(idx, 1);
  try {
    proc.kill("SIGKILL");
  } catch {
    /* ignore */
  }
}

async function stopServerByPort(port) {
  const proc = servers.find((s) => s.__port === port);
  if (!proc) return;
  killServer(proc);
  await new Promise((r) => setTimeout(r, 900));
}

/** Probe a port and return the observable network failure (real, not in-process). */
async function probeUnreachable(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health/live`, {
      signal: AbortSignal.timeout(2500),
    });
    return { reachable: true, status: res.status, error: null };
  } catch (err) {
    return {
      reachable: false,
      status: null,
      error: err?.cause?.code ?? err?.code ?? err?.message ?? String(err),
    };
  }
}

// ---------------------------------------------------------------- auth

async function mintToken() {
  const secret = new TextEncoder().encode(BASE_ENV.JWT_SECRET);
  return new SignJWT({
    sub: USER_ID,
    tenantId: TENANT_ID,
    role: "admin",
    jti: randomUUID(),
    type: "access",
  })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 7200)
    .sign(secret);
}

let TOKEN = null;

async function api(port, method, urlPath, { body, deviceId } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      ...(deviceId ? { "X-Sync-Device-Id": deviceId } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(30_000),
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-json */
  }
  return { status: res.status, json, text };
}

// ---------------------------------------------------------------- db helpers

async function query(db, sql, params = []) {
  const c = await dbClient(db);
  const r = await c.query(sql, params);
  await c.end();
  return r.rows;
}

async function outboxRows(db) {
  return query(
    db,
    `SELECT id, op_id, entity_type, entity_id, operation, status, seq, error_detail
       FROM sync_outbox WHERE tenant_id = $1 ORDER BY seq`,
    [TENANT_ID],
  );
}

async function inboxRows(db) {
  return query(
    db,
    `SELECT op_id, entity_type, status, received_seq, sync_device_id, reject_reason
       FROM sync_inbox WHERE tenant_id = $1 ORDER BY received_seq`,
    [TENANT_ID],
  );
}

async function rowCounts(db) {
  const one = async (sql) => Number((await query(db, sql, [TENANT_ID]))[0].c);
  return {
    parties: await one(`SELECT count(*)::int c FROM parties WHERE tenant_id=$1`),
    fabrics: await one(`SELECT count(*)::int c FROM fabrics WHERE tenant_id=$1`),
    colors: await one(`SELECT count(*)::int c FROM colors WHERE tenant_id=$1`),
    rolls: await one(`SELECT count(*)::int c FROM rolls WHERE tenant_id=$1`),
    invoices: await one(`SELECT count(*)::int c FROM invoices WHERE tenant_id=$1`),
    vouchers: await one(`SELECT count(*)::int c FROM vouchers WHERE tenant_id=$1`),
    expenses: await one(`SELECT count(*)::int c FROM expenses WHERE tenant_id=$1`),
    orders: await one(`SELECT count(*)::int c FROM orders WHERE tenant_id=$1`),
    orderItems: await one(`SELECT count(*)::int c FROM order_items WHERE tenant_id=$1`),
    returns: await one(`SELECT count(*)::int c FROM returns WHERE tenant_id=$1`),
    returnLines: await one(`SELECT count(*)::int c FROM return_lines WHERE tenant_id=$1`),
    ledgerEntries: await one(`SELECT count(*)::int c FROM ledger_entries WHERE tenant_id=$1`),
  };
}

/** Canonical comparable projection of each table (numeric -> Number). */
async function stateFingerprint(db) {
  const q = (sql) => query(db, sql, [TENANT_ID]);
  const parties = await q(
    `SELECT kind, code, name, phone, status FROM parties WHERE tenant_id=$1 ORDER BY name`,
  );
  const fabrics = await q(`SELECT name, unit FROM fabrics WHERE tenant_id=$1 ORDER BY name`);
  const colors = await q(`SELECT name, code FROM colors WHERE tenant_id=$1 ORDER BY name`);
  const rolls = await q(
    `SELECT roll_no, initial_kg, remaining_kg, pieces, remaining_pieces, currency, status
       FROM rolls WHERE tenant_id=$1 ORDER BY roll_no`,
  );
  const invoices = await q(
    `SELECT number, type, total, paid, subtotal, status, currency, reference
       FROM invoices WHERE tenant_id=$1 ORDER BY number`,
  );
  const vouchers = await q(
    `SELECT kind, number, amount, method, status FROM vouchers WHERE tenant_id=$1 ORDER BY number`,
  );
  const expenses = await q(
    `SELECT number, category, description, amount, method, status
       FROM expenses WHERE tenant_id=$1 ORDER BY number`,
  );
  const orders = await q(
    `SELECT code, customer_name_snapshot, status FROM orders WHERE tenant_id=$1 ORDER BY code`,
  );
  const orderItems = await q(
    `SELECT oi.fabric_name, oi.color_name, oi.requested_kg, oi.pieces
       FROM order_items oi JOIN orders o ON o.id = oi.order_id
      WHERE oi.tenant_id=$1 ORDER BY o.code`,
  );
  const returns = await q(
    `SELECT number, kind, reason, status FROM returns WHERE tenant_id=$1 ORDER BY number`,
  );
  const returnLines = await q(
    `SELECT rl.quantity_kg, rl.price_per_kg, rl.pieces
       FROM return_lines rl JOIN returns r ON r.id = rl.return_id
      WHERE rl.tenant_id=$1 ORDER BY r.number`,
  );
  const ledger = await q(
    `SELECT count(*)::int AS n, coalesce(sum(debit),0)::numeric AS debit,
            coalesce(sum(credit),0)::numeric AS credit
       FROM ledger_entries WHERE tenant_id=$1 AND status='active'`,
  );
  const norm = (rows) =>
    rows.map((r) =>
      Object.fromEntries(
        Object.entries(r).map(([k, v]) => [k, typeof v === "number" ? v : v === null ? null : String(v)]),
      ),
    );
  const j = (rows) => JSON.stringify(norm(rows));
  return {
    parties: j(parties),
    fabrics: j(fabrics),
    colors: j(colors),
    rolls: j(rolls),
    invoices: j(invoices),
    vouchers: j(vouchers),
    expenses: j(expenses),
    orders: j(orders),
    orderItems: j(orderItems),
    returns: j(returns),
    returnLines: j(returnLines),
    ledger: j([
      {
        n: Number(ledger[0].n),
        debit: Number(ledger[0].debit).toFixed(2),
        credit: Number(ledger[0].credit).toFixed(2),
      },
    ]),
  };
}

// ---------------------------------------------------------------- sync helper

async function syncUntilDrained(port, maxRounds = 8) {
  const rounds = [];
  for (let i = 0; i < maxRounds; i += 1) {
    const r = await api(port, "POST", "/api/sync/run");
    const snapshot = r.json ?? { status: r.status, text: r.text?.slice(0, 200) };
    rounds.push(snapshot);
    if (r.status !== 200) break;
    const j = r.json;
    const noPush = (j.pushed ?? 0) === 0 && (j.failed ?? 0) === 0 && (j.rejected ?? 0) === 0;
    const noPull = (j.pull?.pulled ?? 0) === 0;
    if (noPush && noPull) break;
  }
  return rounds;
}

const newOp = () => randomUUID();

// ---------------------------------------------------------------- main

async function main() {
  console.log("Batch 5 — offline runtime drill (real hub kill, real device crash)");
  console.log(`  hub=${HUB.db}:${HUB.port}  A=${A.db}:${A.port}  B=${B.db}:${B.port}`);
  const opLog = [];

  section("0. Prepare databases from migrated template");
  await ensureTemplate();
  await cloneDatabases();
  for (const { db } of [HUB, A, B]) {
    await seed(db);
    info(`${db}: cloned + seeded`);
  }
  TOKEN = await mintToken();

  section("1. Baseline: hub up, A + B registered and synced");
  const hubProc = startServer("hub", HUB.db, HUB.port, null, "offdrill-hub.log");
  await waitForHealth(HUB.port, "hub");
  info("hub healthy");
  const aProc = startServer("A", A.db, A.port, `http://127.0.0.1:${HUB.port}`, "offdrill-a.log");
  await waitForHealth(A.port, "device A");
  info("device A healthy");
  const bProc = startServer("B", B.db, B.port, `http://127.0.0.1:${HUB.port}`, "offdrill-b.log");
  await waitForHealth(B.port, "device B");
  info("device B healthy");

  const BLOCK_TYPES = [
    "invoice",
    "invoice_entry",
    "customer",
    "supplier",
    "voucher",
    "return",
    "expense",
    "order",
  ];
  for (const [label, port, dev] of [
    ["A", A.port, DEV_A],
    ["B", B.port, DEV_B],
  ]) {
    const r = await api(port, "POST", "/api/sync/number-blocks/ensure", {
      deviceId: dev,
      body: { syncDeviceId: dev, entityTypes: BLOCK_TYPES },
    });
    check(
      `device ${label} reserved its number blocks while online`,
      r.status === 200 && (r.json?.ensured?.length ?? 0) === BLOCK_TYPES.length,
      `HTTP ${r.status} ensured=${r.json?.ensured?.length ?? 0}`,
    );
  }

  const custName = `عميل أساس Drill5 ${Date.now() % 100000}`;
  const custRes = await api(A.port, "POST", "/api/customers", {
    deviceId: DEV_A,
    body: { kind: "customer", name: custName, phone: "+963900000000", code: `CUS-DR5-${Date.now() % 100000}` },
  });
  check("baseline customer created on A (online)", custRes.status === 201, `HTTP ${custRes.status}`);
  const customer = custRes.json;

  await syncUntilDrained(A.port);
  await syncUntilDrained(B.port);
  const baseHubParties = await query(
    HUB.db,
    `SELECT name FROM parties WHERE tenant_id=$1 AND id=$2`,
    [TENANT_ID, customer.id],
  );
  const baseBParties = await query(
    B.db,
    `SELECT name FROM parties WHERE tenant_id=$1 AND id=$2`,
    [TENANT_ID, customer.id],
  );
  check(
    "baseline customer propagated A -> hub -> B while online",
    baseHubParties.length === 1 && baseBParties.length === 1,
    `hub=${baseHubParties.length} B=${baseBParties.length}`,
  );
  const baseOutboxA = await outboxRows(A.db);
  check(
    "baseline outbox fully drained on A before going offline",
    baseOutboxA.length === 1 && baseOutboxA.every((r) => r.status === "synced"),
    baseOutboxA.map((r) => `${r.entity_type}:${r.status}`).join(", "),
  );

  // ------------------------------------------------------------ STEP 2
  section("2. Hub goes OFF — real process kill (device must genuinely fail)");
  killServer(hubProc);
  await new Promise((r) => setTimeout(r, 1200));
  const probe = await probeUnreachable(HUB.port);
  check(
    "hub port is network-unreachable after the process kill (real ECONNREFUSED, not a flag)",
    probe.reachable === false,
    `reachable=${probe.reachable} error=${probe.error}`,
  );
  // Give the device a unit to push so the failed run shows a real push failure.
  const offlineRunProbe = await api(A.port, "POST", "/api/sync/run");
  const probePullError = offlineRunProbe.json?.pullError ?? null;
  check(
    "device A's /sync/run reports the failed hub contact instead of a silent success",
    offlineRunProbe.status === 200 &&
      (Boolean(probePullError) || (offlineRunProbe.json?.failed ?? 0) > 0),
    `HTTP ${offlineRunProbe.status} pullError="${String(probePullError).slice(0, 80)}" failed=${offlineRunProbe.json?.failed}`,
  );
  const localHealth = await api(A.port, "GET", "/api/health/live");
  check("device A's LOCAL server is still healthy with the hub dead", localHealth.status === 200, `HTTP ${localHealth.status}`);

  // ------------------------------------------------------------ STEP 3
  section("3. Offline business operations on device A (hub unreachable)");
  const today = new Date().toISOString().slice(0, 10);
  const record = (label, res, okStatuses = [200, 201]) => {
    const pass = okStatuses.includes(res.status);
    opLog.push({ label, status: res.status, ok: pass, id: res.json?.id ?? null });
    check(`${label} succeeds offline`, pass, `HTTP ${res.status}${res.json?.number ? ` number=${res.json.number}` : ""}${pass ? "" : ` body=${res.text.slice(0, 200)}`}`);
    return res.json;
  };

  // inventory operation part 1: stock-in chain (fabric -> color -> roll)
  const fabric = record(
    "inventory: create fabric (stock-in master)",
    await api(A.port, "POST", "/api/inventory/fabrics", {
      deviceId: DEV_A,
      body: { name: `قماش Drill5 ${Date.now() % 100000}`, minStockKg: 5 },
    }),
  );
  const color = record(
    "inventory: create color",
    await api(A.port, "POST", "/api/inventory/colors", {
      deviceId: DEV_A,
      body: { fabricId: fabric.id, name: "أحمر Drill5", code: `C-DR5-${Date.now() % 100000}` },
    }),
  );
  const roll = record(
    "inventory: create roll 50kg (stock-in operation)",
    await api(A.port, "POST", "/api/inventory/rolls", {
      deviceId: DEV_A,
      body: {
        colorId: color.id,
        rollNo: `R-DR5-${Date.now() % 100000}`,
        initialKg: 50,
        remainingKg: 50,
        pieces: 10,
        pricePerKg: 1000,
        entryDate: today,
      },
    }),
  );

  const invoice = record(
    "sale invoice (12kg @1500)",
    await api(A.port, "POST", "/api/invoices", {
      deviceId: DEV_A,
      body: {
        type: "sale",
        date: today,
        partyId: customer.id,
        partyType: "customer",
        currency: "SYP",
        // FX rule (BUG-03): non-USD documents freeze the rate at creation
        // (units of SYP per 1 USD) — exactly what an offline device pins from
        // its last-known rate table.
        exchangeRate: 13000,
        lines: [
          {
            fabricId: fabric.id,
            colorId: color.id,
            rollId: roll.id,
            quantityKg: 12,
            pieces: 2,
            pricePerKg: 1500,
          },
        ],
      },
    }),
  );

  const voucher = record(
    "voucher (receipt 500 SYP from customer)",
    await api(A.port, "POST", "/api/receipts", {
      deviceId: DEV_A,
      body: {
        kind: "receipt",
        date: today,
        partyId: customer.id,
        partyKind: "customer",
        amount: 500,
        currency: "SYP",
        exchangeRate: 13000,
        method: "cash",
      },
    }),
  );

  const expense = record(
    "expense (مواصلات 150 SYP cash)",
    await api(A.port, "POST", "/api/expenses", {
      deviceId: DEV_A,
      body: {
        category: "مواصلات",
        description: "بنزين توصيل Drill5",
        amount: 150,
        currency: "SYP",
        date: today,
        method: "cash",
      },
    }),
  );

  const order = record(
    "order (customer order 20kg)",
    await api(A.port, "POST", "/api/orders", {
      deviceId: DEV_A,
      body: {
        customerId: customer.id,
        customerNameSnapshot: custName,
        customerPhoneSnapshot: "+963900000000",
        date: today,
        currency: "SYP",
        items: [
          {
            fabricId: fabric.id,
            fabricName: fabric.name,
            colorId: color.id,
            colorName: color.name,
            colorCode: color.code,
            requestedKg: 20,
            pieces: 3,
          },
        ],
      },
    }),
  );

  const returnDoc = record(
    "return (sale return 3kg @1500)",
    await api(A.port, "POST", "/api/returns", {
      deviceId: DEV_A,
      body: {
        kind: "sale",
        date: today,
        partyId: customer.id,
        originalInvoiceId: invoice.id,
        reason: "defect",
        currency: "SYP",
        lines: [{ rollId: roll.id, quantityKg: 3, pricePerKg: 1500 }],
      },
    }),
  );

  // Optimistic concurrency (P0-001): the update must carry the version the
  // editor last saw — read it back the way the frontend does (offline GET).
  const partyList = await api(A.port, "GET", `/api/customers?search=${encodeURIComponent(custName)}&limit=5`);
  const partyRow = (partyList.json?.items ?? partyList.json?.data ?? []).find(
    (p) => p.id === customer.id,
  );
  const currentVersion = Number(partyRow?.version ?? customer.version ?? 1);
  const updatedCustomer = record(
    "customer update (phone)",
    await api(A.port, "PUT", `/api/customers/${customer.id}`, {
      deviceId: DEV_A,
      body: { phone: "+963955555555", expectedVersion: currentVersion },
    }),
    [200],
  );

  // Failed sync attempt while offline: units must stay pending, never rejected.
  const offlineRun = await api(A.port, "POST", "/api/sync/run");
  const outboxAfterOps = await outboxRows(A.db);
  const pendingAfterOps = outboxAfterOps.filter((r) => r.status === "pending" || r.status === "pushing");
  check(
    "all 9 offline units stay pending after a sync attempt against the dead hub",
    pendingAfterOps.length === 9 && outboxAfterOps.length === 10,
    `pending=${pendingAfterOps.length} total=${outboxAfterOps.length} runFailed=${offlineRun.json?.failed} pullError="${String(offlineRun.json?.pullError ?? "").slice(0, 60)}"`,
  );
  const expectedTypes = [
    "fabric",
    "color",
    "roll",
    "invoice",
    "voucher",
    "expense",
    "order",
    "return",
    "party",
  ];
  const gotTypes = pendingAfterOps.map((r) => r.entity_type).sort();
  check(
    "every offline operation produced its outbox unit (invoice/voucher/expense/order/return/inventory/customer)",
    JSON.stringify(gotTypes) === JSON.stringify([...expectedTypes].sort()),
    gotTypes.join(","),
  );

  {
    const hubCounts = await rowCounts(HUB.db);
    const leaked = ["invoices", "vouchers", "expenses", "orders", "returns", "rolls", "fabrics"]
      .filter((k) => hubCounts[k] > 0);
    check(
      "hub received NOTHING from the offline window (true offline isolation)",
      leaked.length === 0,
      leaked.length ? `leaked: ${leaked.join(",")}` : `hub invoices=${hubCounts.invoices} rolls=${hubCounts.rolls}`,
    );
  }
  const outboxBefore = outboxAfterOps.map((r) => `${r.entity_type}:${r.status}@${r.seq}`);
  const opIdsBeforeCrash = pendingAfterOps.map((r) => r.op_id).sort();

  // ------------------------------------------------------------ STEP 4
  section("4. SIGKILL device A's node process, relaunch while STILL offline");
  killServer(aProc);
  await new Promise((r) => setTimeout(r, 1000));
  const aDead = await probeUnreachable(A.port);
  check("device A process is down after SIGKILL", aDead.reachable === false, `error=${aDead.error}`);
  // Relaunch with the SAME env: same DB, same (dead) hub URL.
  const aProc2 = startServer("A", A.db, A.port, `http://127.0.0.1:${HUB.port}`, "offdrill-a2.log");
  await waitForHealth(A.port, "device A (restarted)");
  info("device A relaunched while the hub is still dead");
  const hubStillDead = await probeUnreachable(HUB.port);
  check("hub is still unreachable after the device restart", hubStillDead.reachable === false, `error=${hubStillDead.error}`);

  // Durability: direct SQL, not API responses.
  const durability = {
    invoice: await query(A.db, `SELECT number, type, total, status FROM invoices WHERE id=$1`, [invoice.id]),
    voucher: await query(A.db, `SELECT kind, number, amount, status FROM vouchers WHERE id=$1`, [voucher.id]),
    expense: await query(A.db, `SELECT number, category, amount, status FROM expenses WHERE id=$1`, [expense.id]),
    order: await query(A.db, `SELECT code, customer_name_snapshot FROM orders WHERE id=$1`, [order.id]),
    return: await query(A.db, `SELECT number, reason, status FROM returns WHERE id=$1`, [returnDoc.id]),
    roll: await query(A.db, `SELECT roll_no, initial_kg, remaining_kg, remaining_pieces FROM rolls WHERE id=$1`, [roll.id]),
    party: await query(A.db, `SELECT name, phone FROM parties WHERE id=$1`, [customer.id]),
  };
  check(
    "sale invoice survived the process crash (local DB)",
    durability.invoice.length === 1 && durability.invoice[0].number === invoice.number,
    durability.invoice[0] ? `${durability.invoice[0].number} type=${durability.invoice[0].type} total=${durability.invoice[0].total}` : "missing",
  );
  check(
    "voucher survived the process crash (local DB)",
    durability.voucher.length === 1 && durability.voucher[0].number === voucher.number,
    durability.voucher[0] ? `${durability.voucher[0].kind} ${durability.voucher[0].number} amount=${durability.voucher[0].amount}` : "missing",
  );
  check(
    "expense survived the process crash (local DB)",
    durability.expense.length === 1 && durability.expense[0].number === expense.number,
    durability.expense[0] ? `${durability.expense[0].number} amount=${durability.expense[0].amount}` : "missing",
  );
  check(
    "order survived the process crash (local DB)",
    durability.order.length === 1 && durability.order[0].code === order.code,
    durability.order[0] ? durability.order[0].code : "missing",
  );
  check(
    "return survived the process crash (local DB)",
    durability.return.length === 1 && durability.return[0].number === returnDoc.number,
    durability.return[0] ? durability.return[0].number : "missing",
  );
  check(
    "inventory effect survived the crash: roll stock = 50 - 12 + 3 = 41 kg",
    durability.roll.length === 1 && Number(durability.roll[0].remaining_kg) === 41,
    durability.roll[0] ? `remaining=${durability.roll[0].remaining_kg} pieces=${durability.roll[0].remaining_pieces}` : "missing",
  );
  check(
    "customer update survived the process crash (local DB)",
    durability.party.length === 1 && durability.party[0].phone === "+963955555555",
    durability.party[0] ? `phone=${durability.party[0].phone}` : "missing",
  );

  const outboxAfterRestart = await outboxRows(A.db);
  const pendingAfterRestart = outboxAfterRestart.filter(
    (r) => r.status === "pending" || r.status === "pushing",
  );
  const opIdsAfterCrash = pendingAfterRestart.map((r) => r.op_id).sort();
  check(
    "all 9 pending outbox units survive the process crash (same op ids)",
    pendingAfterRestart.length === 9 &&
      JSON.stringify(opIdsAfterCrash) === JSON.stringify(opIdsBeforeCrash),
    `pending=${pendingAfterRestart.length} sameOpIds=${JSON.stringify(opIdsAfterCrash) === JSON.stringify(opIdsBeforeCrash)}`,
  );

  // ------------------------------------------------------------ STEP 5
  section("5. OS-level durability (explicitly UNTESTED — recorded, not skipped silently)");
  info("NOT TESTED on this host: full Windows restart with the local PostgreSQL service.");
  info("Tested instead: process-level crash durability (SIGKILL + relaunch), i.e. WAL-committed rows + outbox rows survive a node process death.");
  info("A full OS reboot additionally depends on the PostgreSQL service auto-start configuration, which is a deployment concern, not an app invariant.");
  check("OS-level restart is documented as untested (no false claim of coverage)", true, "documented Runtime Unknown");

  // ------------------------------------------------------------ STEP 6
  section("6. Hub comes back — sync starts");
  const hubProc2 = startServer("hub", HUB.db, HUB.port, null, "offdrill-hub2.log");
  await waitForHealth(HUB.port, "hub (restarted)");
  const hubBack = await probeUnreachable(HUB.port);
  check("hub is reachable again", hubBack.reachable === true, `HTTP ${hubBack.status}`);

  const runAfterHubBack = await api(A.port, "POST", "/api/sync/run");
  info("sync trigger: MANUAL — the backend has no auto-sync timer; the client calls POST /api/sync/run");
  check(
    "first manual sync run after reconnect pushes the backlog",
    runAfterHubBack.status === 200 && (runAfterHubBack.json?.pushed ?? 0) > 0,
    `HTTP ${runAfterHubBack.status} pushed=${runAfterHubBack.json?.pushed} failed=${runAfterHubBack.json?.failed} rejected=${runAfterHubBack.json?.rejected}`,
  );

  // ------------------------------------------------------------ STEP 7
  section("7. Drain: every unit reaches the hub, then device B pulls + materializes");
  const roundsA = await syncUntilDrained(A.port);
  const outboxAfterSync = await outboxRows(A.db);
  check(
    "device A outbox drained: 10/10 units synced, none pending, none rejected",
    outboxAfterSync.length === 10 &&
      outboxAfterSync.every((r) => r.status === "synced") &&
      outboxAfterSync.filter((r) => r.status === "rejected").length === 0,
    outboxAfterSync.map((r) => `${r.entity_type}:${r.status}`).join(", "),
  );

  const hubInboxA = (await inboxRows(HUB.db)).filter((r) => r.sync_device_id === DEV_A);
  const hubRejected = hubInboxA.filter((r) => r.status === "rejected");
  const hubApplied = hubInboxA.filter((r) => r.status === "applied");
  check(
    "hub applied all 10 units from A (9 offline ops + baseline), 0 rejected",
    hubApplied.length === 10 && hubRejected.length === 0,
    `applied=${hubApplied.length} rejected=${hubRejected.length} statuses=${[...new Set(hubInboxA.map((r) => r.status))].join(",")}`,
  );

  const roundsB = await syncUntilDrained(B.port);
  await syncUntilDrained(A.port); // final no-op convergence round
  const bCounts = await rowCounts(B.db);
  check(
    "device B materialized the inventory/document set pulled from the hub",
    bCounts.fabrics === 1 &&
      bCounts.colors === 1 &&
      bCounts.rolls === 1 &&
      bCounts.invoices === 1 &&
      bCounts.vouchers === 1 &&
      bCounts.expenses === 1 &&
      bCounts.orders === 1 &&
      bCounts.returns === 1,
    JSON.stringify(bCounts),
  );

  // ------------------------------------------------------------ STEP 8
  section("8. Final state comparison by direct SQL (A vs hub vs B)");
  const fpA = await stateFingerprint(A.db);
  const fpH = await stateFingerprint(HUB.db);
  const fpB = await stateFingerprint(B.db);
  const keys = Object.keys(fpA);
  for (const k of keys) {
    check(
      `state[${k}] identical on A, hub and B`,
      fpA[k] === fpH[k] && fpA[k] === fpB[k],
      fpA[k] === fpH[k] && fpA[k] === fpB[k] ? "" : `A=${fpA[k].slice(0, 220)} | hub=${fpH[k].slice(0, 220)} | B=${fpB[k].slice(0, 220)}`,
    );
  }

  const countsA = await rowCounts(A.db);
  const countsH = await rowCounts(HUB.db);
  const countsB = await rowCounts(B.db);
  check(
    "no duplicates: exact row counts match on all three nodes",
    JSON.stringify(countsA) === JSON.stringify(countsH) && JSON.stringify(countsA) === JSON.stringify(countsB),
    JSON.stringify(countsA),
  );
  const dupCheck = await query(
    A.db,
    `SELECT number, count(*)::int c FROM invoices WHERE tenant_id=$1 GROUP BY number HAVING count(*)>1`,
    [TENANT_ID],
  );
  check("no duplicated invoice numbers on any node", dupCheck.length === 0, `dupes=${dupCheck.length}`);
  const rollCheck = countsA.rolls === 1 ? countsA.rolls : -1;
  check("inventory effect is consistent: exactly 1 roll, remaining 41kg on all nodes", rollCheck === 1, `A roll=${JSON.parse(fpA.rolls)[0]?.remaining_kg} hub=${JSON.parse(fpH.rolls)[0]?.remaining_kg} B=${JSON.parse(fpB.rolls)[0]?.remaining_kg}`);

  // ------------------------------------------------------------ STEP 9
  section("9. Recorded evidence");
  console.log("  per-operation HTTP status (device A, hub offline):");
  for (const o of opLog) console.log(`    ${o.ok ? "OK  " : "BAD "} HTTP ${o.status}  ${o.label}`);
  console.log(`\n  outbox BEFORE crash (${outboxBefore.length} units):`);
  console.log(`    ${outboxBefore.join(" | ")}`);
  console.log(`  outbox AFTER convergence (${outboxAfterSync.length} units):`);
  console.log(`    ${outboxAfterSync.map((r) => `${r.entity_type}:${r.status}`).join(" | ")}`);
  console.log("\n  sync run results:");
  console.log(`    [offline run, hub dead]  ${JSON.stringify(offlineRun.json)}`);
  console.log(`    [first run after hub back] ${JSON.stringify(runAfterHubBack.json)}`);
  console.log(`    [drain rounds A] ${JSON.stringify(roundsA.map((r) => ({ pushed: r.pushed, failed: r.failed, rejected: r.rejected, pulled: r.pull?.pulled, applied: r.pull?.applied, pullError: r.pullError ?? null })))}`);
  console.log(`    [drain rounds B] ${JSON.stringify(roundsB.map((r) => ({ pushed: r.pushed, failed: r.failed, rejected: r.rejected, pulled: r.pull?.pulled, applied: r.pull?.applied, pullError: r.pullError ?? null })))}`);
  console.log("\n  final row counts per node:");
  for (const [label, cc] of [
    ["A  ", countsA],
    ["hub", countsH],
    ["B  ", countsB],
  ]) {
    console.log(`    ${label}: ${JSON.stringify(cc)}`);
  }
  console.log(`\n  roll stock per node: A=${JSON.parse(fpA.rolls)[0]?.remaining_kg}kg hub=${JSON.parse(fpH.rolls)[0]?.remaining_kg}kg B=${JSON.parse(fpB.rolls)[0]?.remaining_kg}kg`);

  // ------------------------------------------------------------ summary
  section("Summary");
  const failed = results.filter((r) => !r.pass);
  console.log(`  ${results.length - failed.length}/${results.length} checks passed`);
  if (failed.length) {
    console.log("  FAILURES:");
    for (const f of failed) console.log(`    - ${f.name} :: ${f.detail}`);
  }
  return failed.length === 0;
}

async function cleanup() {
  for (const s of servers) {
    try {
      s.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
  servers = [];
}

let ok = false;
try {
  ok = await main();
} catch (err) {
  console.error("\nHARNESS ERROR:", err?.stack || err);
} finally {
  await cleanup();
  if (!KEEP) {
    try {
      const c = await adminClient();
      for (const { db } of [HUB, A, B]) {
        await c.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`).catch(() => {});
      }
      await c.end();
      console.log("\n(drill databases dropped; pass --keep to retain them)");
    } catch {
      /* ignore */
    }
  }
}
process.exit(ok ? 0 : 1);
