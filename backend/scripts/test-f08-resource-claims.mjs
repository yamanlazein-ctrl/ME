/**
 * F-08 — Sync resource claim acceptance tests (Strategy B).
 *
 * Strategy B: master data creation (party/fabric/color/roll) claims NO
 * resources. Transactions (invoice vs invoice) still claim `roll:<id>`.
 *
 * What the defect was: the route ran the business use-case (which committed in
 * its own repository transaction) and THEN inserted the outbox row on a
 * separate pooled connection inside `try { ... } catch { logger.warn }`. A
 * failed enqueue therefore produced a locally-committed document with no sync
 * unit — invisible divergence that nothing could repair, because no process
 * re-scans business tables for un-enqueued writes.
 *
 * HOW FAILURE IS INJECTED
 *   A PostgreSQL BEFORE INSERT trigger on `sync_outbox` raises an exception for
 *   a sentinel op-id. That is a real database-level failure of exactly the
 *   operation we want to prove atomicity for — not a mock, not a stubbed
 *   repository. With the fix in place the whole transaction must roll back:
 *   the business row must NOT exist afterwards.
 *
 * Every check runs against real PostgreSQL databases cloned from the migrated
 * `sync_tpl` template and real backend processes — no mocks anywhere.
 *
 * Master updates/cancels asserted here MUST carry `expectedVersion` (P0-001):
 * the local route rejects a missing base with HTTP 400, and the hub refuses a
 * stale base instead of overwriting a newer edit. The drill reads the current
 * version from the database each request will run against (`versionOf`).
 *
 * Usage:  node scripts/test-f08-resource-claims.mjs --keep
 */
import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";

const BACKEND = path.resolve(import.meta.dirname, "..");
const KEEP = process.argv.includes("--keep");
const PG = { host: "localhost", port: 5432, user: "postgres", password: "postgres" };

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const DEV_A = "33333333-3333-4333-8333-333333333333";
const DEV_B = "44444444-4444-4444-8444-444444444444";

const HUB = { db: "sync_hub", port: 8091 };
const A = { db: "sync_dev_a", port: 8092 };
const B = { db: "sync_dev_b", port: 8093 };
const TEMPLATE_DB = "sync_tpl";

const results = [];
const servers = [];

function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}
function section(title) {
  console.log(`\n=== ${title} ===`);
}

// ------------------------------------------------------------------ env

function loadEnv() {
  const env = {};
  for (const file of ["../.env", ".env"]) {
    const p = path.resolve(BACKEND, file);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/.exec(line);
      if (!m) continue;
      let v = m[2];
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'")))
        v = v.slice(1, -1);
      env[m[1]] = v;
    }
  }
  return env;
}
const BASE_ENV = loadEnv();
const dbUrl = (db) => `postgresql://${PG.user}:${PG.password}@${PG.host}:${PG.port}/${db}`;

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

// ------------------------------------------------------------------ setup

async function cloneDatabases() {
  const c = await adminClient();
  for (const { db } of [HUB, A, B]) {
    await c.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
    await c.query(`CREATE DATABASE "${db}" TEMPLATE "${TEMPLATE_DB}"`);
  }
  await c.end();
}

async function seed(db) {
  const c = await dbClient(db);
  await c.query(
    `INSERT INTO tenants (id, name, slug, status, license_status, license_type)
     VALUES ($1, 'F-07 Tenant', $2, 'active', 'no_license', 'trial')
     ON CONFLICT (id) DO NOTHING`,
    [TENANT_ID, `f07-${db}`],
  );
  await c.query(
    `INSERT INTO users (id, tenant_id, name, email, password_hash, role, active)
     VALUES ($1, $2, 'F-07 Admin', $3, 'not-used', 'admin', true)
     ON CONFLICT (id) DO NOTHING`,
    [USER_ID, TENANT_ID, `admin-${db}@f07.local`],
  );
  for (const [id, label] of [
    [DEV_A, "device-a"],
    [DEV_B, "device-b"],
  ]) {
    await c.query(
      // Batch 4 / 4B: bound to the registering user, like an API-registered
      // device (the sync device gate refuses unbound devices).
      `INSERT INTO sync_devices (id, tenant_id, device_fingerprint, platform, hostname, label,
                                 last_seen_by_user_id, authorized_user_ids)
       VALUES ($1, $2, $3, 'windows', $4, $4, $5, ARRAY[$5]::uuid[]) ON CONFLICT (id) DO NOTHING`,
      [id, TENANT_ID, `fp-${label}-${db}`, label, USER_ID],
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
  delete env.CENTRAL_SYNC_URL;
  delete env.DESKTOP_DEPLOY;
  if (centralUrl) env.CENTRAL_SYNC_URL = centralUrl;

  const child = spawn(
    process.execPath,
    ["node_modules/tsx/dist/cli.mjs", "src/presentation/server.ts"],
    {
      cwd: BACKEND,
      env,
      stdio: ["ignore", out, out],
    },
  );
  child.__name = name;
  child.__port = port;
  servers.push(child);
  return child;
}

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
      lastErr = err?.message ?? String(err);
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  let tail = "";
  for (const f of ["f07-hub.log", "f07-a.log", "f07-b.log"]) {
    const p = path.join(BACKEND, f);
    if (fs.existsSync(p) && fs.statSync(p).size > 0)
      tail += `\n----- ${f} -----\n${fs.readFileSync(p, "utf8").slice(-3000)}`;
  }
  throw new Error(`${label} not healthy on :${port} (last: ${lastErr})${tail}`);
}

async function stopAllServers() {
  for (const s of servers) {
    try {
      s.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
  await new Promise((r) => setTimeout(r, 1000));
}

// ------------------------------------------------------------------ auth / api

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

async function api(port, method, urlPath, { body, deviceId, headers = {} } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      ...(deviceId ? { "X-Sync-Device-Id": deviceId } : {}),
      ...headers,
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

// ------------------------------------------------------------------ db helpers

async function q(db, sql, params = []) {
  const c = await dbClient(db);
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
}

/**
 * Optimistic-concurrency version of a row, read from the database the request
 * will run against. Master updates/cancels REQUIRE `expectedVersion` in the body
 * (P0-001: the hub refuses a stale-base replay instead of overwriting a newer
 * edit), so a drill that omits it gets HTTP 400 and silently stops testing the
 * convergence path it was written for.
 */
const versionOf = async (db, table, id) =>
  Number((await q(db, `SELECT version FROM ${table} WHERE id = $1`, [id]))[0]?.version ?? 0);

const OUTBOX_FAIL_TRIGGER = "f07_fail_outbox_insert";

/**
 * Inject a REAL database failure into sync_outbox inserts for one sentinel
 * op-id. Any enqueue carrying that op-id now raises, exactly as a disk-full /
 * constraint / connection failure would at that statement.
 */
async function installOutboxFailureTrigger(db, sentinelOpId) {
  await q(db, `DROP TRIGGER IF EXISTS ${OUTBOX_FAIL_TRIGGER} ON sync_outbox`);
  await q(
    db,
    `CREATE OR REPLACE FUNCTION f07_fail_outbox_insert_fn() RETURNS trigger AS $$
     BEGIN
       IF NEW.op_id::text = '${sentinelOpId}' THEN
         RAISE EXCEPTION 'F-07 injected outbox failure for op %', NEW.op_id;
       END IF;
       RETURN NEW;
     END; $$ LANGUAGE plpgsql`,
  );
  await q(
    db,
    `CREATE TRIGGER ${OUTBOX_FAIL_TRIGGER} BEFORE INSERT ON sync_outbox
     FOR EACH ROW EXECUTE FUNCTION f07_fail_outbox_insert_fn()`,
  );
}

async function removeOutboxFailureTrigger(db) {
  await q(db, `DROP TRIGGER IF EXISTS ${OUTBOX_FAIL_TRIGGER} ON sync_outbox`);
  await q(db, `DROP FUNCTION IF EXISTS f07_fail_outbox_insert_fn()`);
}

const countWhere = async (db, table, entityId) =>
  Number(
    (
      await q(db, `SELECT count(*)::int AS c FROM ${table} WHERE tenant_id = $1 AND id = $2`, [
        TENANT_ID,
        entityId,
      ])
    )[0].c,
  );

const outboxFor = async (db, entityId) =>
  q(
    db,
    `SELECT op_id, entity_type, entity_id, operation, status FROM sync_outbox
         WHERE tenant_id = $1 AND entity_id = $2`,
    [TENANT_ID, entityId],
  );

/** Build a stock chain (fabric → color → roll) so a sale invoice can be created. */
async function mkStock(port, deviceId, kg = 5000, cost = 500, pieces = 1) {
  const u = randomUUID().slice(0, 8);
  const fab = (
    await api(port, "POST", "/api/inventory/fabrics", { deviceId, body: { name: `قماش ${u}` } })
  ).json;
  const col = (
    await api(port, "POST", "/api/inventory/colors", {
      deviceId,
      body: { fabricId: fab.id, name: `لون ${u}`, code: `C${u}` },
    })
  ).json;
  const roll = (
    await api(port, "POST", "/api/inventory/rolls", {
      deviceId,
      body: {
        colorId: col.id,
        rollNo: `R-${u}`,
        initialKg: kg,
        remainingKg: kg,
        pieces,
        pricePerKg: cost,
        entryDate: "2026-01-15",
      },
    })
  ).json;
  return { fab, col, roll };
}

async function mkCustomer(port, deviceId, name) {
  return (await api(port, "POST", "/api/customers", { deviceId, body: { name } })).json;
}

async function mkSale(port, deviceId, partyId, line) {
  const r = await api(port, "POST", "/api/invoices", {
    deviceId,
    body: {
      type: "sale",
      date: "2026-01-15",
      partyId,
      partyType: "customer",
      currency: "SYP",
      exchangeRate: 15000,
      lines: [line],
    },
  });
  if (r.status !== 201)
    console.log(`  [mkSale FAIL] status=${r.status} body=${r.text?.slice(0, 300)}`);
  return r;
}

/** Loop sync/run until nothing is pushed and nothing new is pulled. */
async function syncUntilDrained(port, deviceId, maxRounds = 8) {
  const rounds = [];
  for (let i = 0; i < maxRounds; i += 1) {
    const r = await api(port, "POST", "/api/sync/run", { deviceId });
    rounds.push(r.json ?? { status: r.status });
    if (r.status !== 200) {
      console.log(`  [drain FAIL] status=${r.status} body=${r.text?.slice(0, 200)}`);
      break;
    }
    const j = r.json;
    const noPush = (j.pushed ?? 0) === 0 && (j.failed ?? 0) === 0 && (j.rejected ?? 0) === 0;
    const noPull = (j.pull?.pulled ?? 0) === 0;
    if (noPush && noPull) break;
  }
  return rounds;
}

// ------------------------------------------------------------------ main

async function main() {
  console.log("F-08 — Sync resource claim acceptance (Strategy B)\n");

  section("0. Prepare databases from migrated template");
  await cloneDatabases();
  for (const { db } of [HUB, A, B]) await seed(db);
  console.log("  sync_hub / sync_dev_a / sync_dev_b cloned + seeded");

  section("0b. Start hub + two device nodes");
  startServer("hub", HUB.db, HUB.port, null, "f07-hub.log");
  await waitForHealth(HUB.port, "hub");
  console.log("  hub healthy");
  startServer("A", A.db, A.port, `http://127.0.0.1:${HUB.port}`, "f07-a.log");
  await waitForHealth(A.port, "device A");
  console.log("  device A healthy");
  startServer("B", B.db, B.port, `http://127.0.0.1:${HUB.port}`, "f07-b.log");
  await waitForHealth(B.port, "device B");
  console.log("  device B healthy");

  TOKEN = await mintToken();

  // ------------------------------------------------------------------
  section("0c. Provision number blocks");
  const F08_BLOCK_TYPES = ["invoice", "invoice_entry", "customer", "supplier", "return"];
  for (const [label, port, dev] of [
    ["device A", A.port, DEV_A],
    ["device B", B.port, DEV_B],
  ]) {
    const r = await api(port, "POST", "/api/sync/number-blocks/ensure", {
      deviceId: dev,
      body: { syncDeviceId: dev, entityTypes: F08_BLOCK_TYPES },
    });
    check(`${label} reserved its number blocks`, r.status === 200, `HTTP ${r.status}`);
  }

  // Device gate: both devices register their asserted UUIDs on the HUB, so
  // hub push gates recognize them. Registration binds fingerprint → UUID.
  // Batch 4 / 4B: the hub already holds these device rows (seeded above, with
  // authorized_user_ids), so re-registering must announce the SAME
  // fingerprint — a different one is exactly the forged-device-id takeover
  // the fingerprint-mismatch guard refuses with 403.
  section("0d. Register both devices on the hub");
  for (const [label, dev, seededFingerprint] of [
    ["device A", DEV_A, `fp-device-a-${HUB.db}`],
    ["device B", DEV_B, `fp-device-b-${HUB.db}`],
  ]) {
    const r = await api(HUB.port, "POST", "/api/auth/sync-device", {
      deviceId: dev,
      body: {
        deviceFingerprint: seededFingerprint,
        platform: "windows",
        hostname: label,
        label: `F08 ${label}`,
        deviceId: dev,
      },
    });
    check(
      `${label} registered on hub`,
      r.status === 200 && r.json?.id === dev,
      `HTTP ${r.status} id=${r.json?.id}`,
    );
  }

  // ---- T1: roll creation + sale both reach the hub (the original divergence) ----
  section("T1. Roll creation + sale invoice both reach the hub");
  {
    const stock = await mkStock(A.port, DEV_A);
    const cust = await mkCustomer(A.port, DEV_A, "F08-T1-Customer");
    const sale = await mkSale(A.port, DEV_A, cust.id, {
      fabricId: stock.fab.id,
      colorId: stock.col.id,
      rollId: stock.roll.id,
      quantityKg: 10,
      pricePerKg: 1000,
    });
    check("sale invoice created locally", sale.status === 201, `HTTP ${sale.status}`);
    const saleId = sale.json.id;
    await syncUntilDrained(A.port, DEV_A);
    const hubRolls = await q(HUB.db, `SELECT id FROM rolls WHERE tenant_id=$1 AND id=$2`, [
      TENANT_ID,
      stock.roll.id,
    ]);
    const hubInv = await q(HUB.db, `SELECT id, number FROM invoices WHERE tenant_id=$1 AND id=$2`, [
      TENANT_ID,
      saleId,
    ]);
    const hubKg = await q(HUB.db, `SELECT remaining_kg FROM rolls WHERE tenant_id=$1 AND id=$2`, [
      TENANT_ID,
      stock.roll.id,
    ]);
    check(
      "roll created on the hub (no roll-vs-invoice conflict)",
      hubRolls.length === 1,
      `rows=${hubRolls.length}`,
    );
    check("sale invoice reached the hub", hubInv.length === 1, `hub=${JSON.stringify(hubInv)}`);
    check(
      "hub deducted the sold stock (5000-10=4990)",
      Number(hubKg[0]?.remaining_kg) === 4990,
      `remaining=${hubKg[0]?.remaining_kg}`,
    );
  }

  // ---- T2: two concurrent sales on one roll ----
  // P3a quantity-aware FWW measures BOTH kilograms and pieces (the invoice
  // use-case guards both). The default roll holds 1 piece: two 10kg sales fit
  // in kilograms but only one piece exists, so exactly one wins — on pieces,
  // with figures, not on a blind whole-roll lock.
  section("T2. Sale-vs-sale on one 1-piece roll (pieces decide, figures reported)");
  {
    const stock = await mkStock(A.port, DEV_A);
    const custA = await mkCustomer(A.port, DEV_A, "F08-T2-A");
    await syncUntilDrained(A.port, DEV_A);
    await syncUntilDrained(B.port, DEV_B);
    const custB = await mkCustomer(B.port, DEV_B, "F08-T2-B");
    const saleA = await mkSale(A.port, DEV_A, custA.id, {
      fabricId: stock.fab.id,
      colorId: stock.col.id,
      rollId: stock.roll.id,
      quantityKg: 10,
      pricePerKg: 1000,
    });
    const saleB = await mkSale(B.port, DEV_B, custB.id, {
      fabricId: stock.fab.id,
      colorId: stock.col.id,
      rollId: stock.roll.id,
      quantityKg: 10,
      pricePerKg: 1000,
    });
    check(
      "both sales created locally",
      saleA.status === 201 && saleB.status === 201,
      `A=${saleA.status} B=${saleB.status} Bbody=${saleB.text?.slice(0, 250)}`,
    );
    const runA = await syncUntilDrained(A.port, DEV_A);
    const runB = await syncUntilDrained(B.port, DEV_B);
    const totalRejected = [...runA, ...runB].reduce((n, r) => n + (r.rejected ?? 0), 0);
    const hubSales = await q(
      HUB.db,
      `SELECT id FROM invoices WHERE tenant_id=$1 AND (id=$2 OR id=$3)`,
      [TENANT_ID, saleA.json.id, saleB.json.id],
    );
    check(
      "exactly one sale won on the hub (one piece, two claimants)",
      hubSales.length === 1 && totalRejected === 1,
      `hubSales=${hubSales.length} rejected=${totalRejected}`,
    );
    const hubKg = await q(
      HUB.db,
      `SELECT remaining_kg, remaining_pieces FROM rolls WHERE tenant_id=$1 AND id=$2`,
      [TENANT_ID, stock.roll.id],
    );
    check(
      "hub stock deducted exactly once (5000-10=4990, pieces 0)",
      Number(hubKg[0]?.remaining_kg) === 4990 && Number(hubKg[0]?.remaining_pieces) === 0,
      `remaining=${hubKg[0]?.remaining_kg} pieces=${hubKg[0]?.remaining_pieces}`,
    );
    const loserRejected = await q(
      HUB.db,
      `SELECT reject_reason, conflict_detail FROM sync_inbox WHERE tenant_id=$1 AND status='rejected' AND entity_type='invoice' AND (entity_id=$2 OR entity_id=$3)`,
      [TENANT_ID, saleA.json.id, saleB.json.id],
    );
    const detail = loserRejected[0]?.conflict_detail
      ? JSON.stringify(loserRejected[0].conflict_detail)
      : "";
    check(
      "loser rejection carries pieces figures",
      /requestedPieces/.test(detail) && /availablePieces/.test(detail),
      `detail=${detail.slice(0, 200)}`,
    );
  }

  // ---- T2c: two sales that fit in BOTH dimensions both win ----
  section("T2c. Sale-vs-sale on a 5-piece roll (both win, no false conflict)");
  {
    const stock = await mkStock(A.port, DEV_A, 5000, 500, 5);
    const custA = await mkCustomer(A.port, DEV_A, "F08-T2c-A");
    await syncUntilDrained(A.port, DEV_A);
    await syncUntilDrained(B.port, DEV_B);
    const custB = await mkCustomer(B.port, DEV_B, "F08-T2c-B");
    const saleA = await mkSale(A.port, DEV_A, custA.id, {
      fabricId: stock.fab.id,
      colorId: stock.col.id,
      rollId: stock.roll.id,
      quantityKg: 10,
      pricePerKg: 1000,
    });
    const saleB = await mkSale(B.port, DEV_B, custB.id, {
      fabricId: stock.fab.id,
      colorId: stock.col.id,
      rollId: stock.roll.id,
      quantityKg: 10,
      pricePerKg: 1000,
    });
    check(
      "both sales created locally",
      saleA.status === 201 && saleB.status === 201,
      `A=${saleA.status} B=${saleB.status}`,
    );
    await syncUntilDrained(A.port, DEV_A);
    await syncUntilDrained(B.port, DEV_B);
    const hubSales = await q(
      HUB.db,
      `SELECT id FROM invoices WHERE tenant_id=$1 AND (id=$2 OR id=$3)`,
      [TENANT_ID, saleA.json.id, saleB.json.id],
    );
    check(
      "both fitting sales won on the hub (no false conflict)",
      hubSales.length === 2,
      `hubSales=${hubSales.length}`,
    );
    const hubKg = await q(
      HUB.db,
      `SELECT remaining_kg, remaining_pieces FROM rolls WHERE tenant_id=$1 AND id=$2`,
      [TENANT_ID, stock.roll.id],
    );
    check(
      "hub stock deducted twice (5000-10-10=4980, pieces 5-1-1=3)",
      Number(hubKg[0]?.remaining_kg) === 4980 && Number(hubKg[0]?.remaining_pieces) === 3,
      `remaining=${hubKg[0]?.remaining_kg} pieces=${hubKg[0]?.remaining_pieces}`,
    );
  }

  // ---- T2b: over-claim — two concurrent sales exceeding stock -> one wins ----
  section("T2b. Over-claim on the same roll (exactly one winner, figures reported)");
  {
    const stock = await mkStock(A.port, DEV_A);
    const custA = await mkCustomer(A.port, DEV_A, "F08-T2b-A");
    await syncUntilDrained(A.port, DEV_A);
    await syncUntilDrained(B.port, DEV_B);
    const custB = await mkCustomer(B.port, DEV_B, "F08-T2b-B");
    const saleA = await mkSale(A.port, DEV_A, custA.id, {
      fabricId: stock.fab.id,
      colorId: stock.col.id,
      rollId: stock.roll.id,
      quantityKg: 4000,
      pricePerKg: 1000,
    });
    const saleB = await mkSale(B.port, DEV_B, custB.id, {
      fabricId: stock.fab.id,
      colorId: stock.col.id,
      rollId: stock.roll.id,
      quantityKg: 4000,
      pricePerKg: 1000,
    });
    check(
      "both sales created locally",
      saleA.status === 201 && saleB.status === 201,
      `A=${saleA.status} B=${saleB.status}`,
    );
    const runA = await syncUntilDrained(A.port, DEV_A);
    const runB = await syncUntilDrained(B.port, DEV_B);
    const totalRejected = [...runA, ...runB].reduce((n, r) => n + (r.rejected ?? 0), 0);
    const hubSales = await q(
      HUB.db,
      `SELECT id FROM invoices WHERE tenant_id=$1 AND (id=$2 OR id=$3)`,
      [TENANT_ID, saleA.json.id, saleB.json.id],
    );
    check(
      "exactly one over-claiming sale won on the hub (no double-selling)",
      hubSales.length === 1 && totalRejected === 1,
      `hubSales=${hubSales.length} rejected=${totalRejected}`,
    );
    const hubKg = await q(HUB.db, `SELECT remaining_kg FROM rolls WHERE tenant_id=$1 AND id=$2`, [
      TENANT_ID,
      stock.roll.id,
    ]);
    check(
      "hub stock deducted exactly once (5000-4000=1000)",
      Number(hubKg[0]?.remaining_kg) === 1000,
      `remaining=${hubKg[0]?.remaining_kg}`,
    );
    const loserRejected = await q(
      HUB.db,
      `SELECT reject_reason, conflict_detail FROM sync_inbox WHERE tenant_id=$1 AND status='rejected' AND entity_type='invoice' AND (entity_id=$2 OR entity_id=$3)`,
      [TENANT_ID, saleA.json.id, saleB.json.id],
    );
    const detail = loserRejected[0]?.conflict_detail
      ? JSON.stringify(loserRejected[0].conflict_detail)
      : "";
    check(
      "loser rejection carries available/requested figures",
      /availableKg/.test(detail) && /requestedKg/.test(detail),
      `detail=${detail.slice(0, 160)}`,
    );
  }

  // ---- T3: sale + return on the same roll ----
  section("T3. Sale + return on the same roll (no false conflict)");
  {
    const stock = await mkStock(A.port, DEV_A);
    await syncUntilDrained(A.port, DEV_A);
    await syncUntilDrained(B.port, DEV_B);
    const cust = await mkCustomer(A.port, DEV_A, "F08-T3-Customer");
    const sale = await mkSale(A.port, DEV_A, cust.id, {
      fabricId: stock.fab.id,
      colorId: stock.col.id,
      rollId: stock.roll.id,
      quantityKg: 10,
      pricePerKg: 1000,
    });
    check(
      "sale created locally",
      sale.status === 201,
      `HTTP ${sale.status} body=${sale.text.slice(0, 300)}`,
    );
    await syncUntilDrained(A.port, DEV_A);
    const ret = await api(A.port, "POST", "/api/returns", {
      deviceId: DEV_A,
      body: {
        kind: "sale",
        date: "2026-01-16",
        partyId: cust.id,
        reason: "defect",
        lines: [{ rollId: stock.roll.id, quantityKg: 4, pricePerKg: 1000 }],
      },
    });
    const retOk = ret.status === 201;
    await syncUntilDrained(A.port, DEV_A);
    const hubKg = await q(HUB.db, `SELECT remaining_kg FROM rolls WHERE tenant_id=$1 AND id=$2`, [
      TENANT_ID,
      stock.roll.id,
    ]);
    check(
      "sale and return both applied (5000-10+4=4994)",
      retOk && Number(hubKg[0]?.remaining_kg) === 4994,
      `ret=${ret.status} retBody=${ret.text.slice(0, 300)} remaining=${hubKg[0]?.remaining_kg}`,
    );
  }

  // ---- T4: roll creation alone ----
  section("T4. Roll creation alone reaches the hub");
  {
    const stock = await mkStock(A.port, DEV_A);
    await syncUntilDrained(A.port, DEV_A);
    const hubRolls = await q(HUB.db, `SELECT id FROM rolls WHERE tenant_id=$1 AND id=$2`, [
      TENANT_ID,
      stock.roll.id,
    ]);
    check("standalone roll created on the hub", hubRolls.length === 1, `rows=${hubRolls.length}`);
  }

  // ---- T5: multi-roll invoice ----
  section("T5. Multi-roll invoice");
  {
    const s1 = await mkStock(A.port, DEV_A);
    const s2 = await mkStock(A.port, DEV_A);
    const cust = await mkCustomer(A.port, DEV_A, "F08-T5-Customer");
    const sale = await api(A.port, "POST", "/api/invoices", {
      deviceId: DEV_A,
      body: {
        type: "sale",
        date: "2026-01-15",
        partyId: cust.id,
        partyType: "customer",
        currency: "SYP",
        exchangeRate: 15000,
        lines: [
          {
            fabricId: s1.fab.id,
            colorId: s1.col.id,
            rollId: s1.roll.id,
            quantityKg: 5,
            pricePerKg: 1000,
          },
          {
            fabricId: s2.fab.id,
            colorId: s2.col.id,
            rollId: s2.roll.id,
            quantityKg: 7,
            pricePerKg: 1000,
          },
        ],
      },
    });
    check("multi-roll invoice created locally", sale.status === 201, `HTTP ${sale.status}`);
    await syncUntilDrained(A.port, DEV_A);
    const hubInv = await q(HUB.db, `SELECT id FROM invoices WHERE tenant_id=$1 AND id=$2`, [
      TENANT_ID,
      sale.json.id,
    ]);
    const k1 = await q(HUB.db, `SELECT remaining_kg FROM rolls WHERE tenant_id=$1 AND id=$2`, [
      TENANT_ID,
      s1.roll.id,
    ]);
    const k2 = await q(HUB.db, `SELECT remaining_kg FROM rolls WHERE tenant_id=$1 AND id=$2`, [
      TENANT_ID,
      s2.roll.id,
    ]);
    check(
      "multi-roll invoice reached hub and both rolls deducted",
      hubInv.length === 1 &&
        Number(k1[0]?.remaining_kg) === 4995 &&
        Number(k2[0]?.remaining_kg) === 4993,
      `inv=${hubInv.length} r1=${k1[0]?.remaining_kg} r2=${k2[0]?.remaining_kg}`,
    );
  }

  // ---- T6: restart keeps pending ----
  section("T6. Restart: pending units survive");
  {
    await mkCustomer(A.port, DEV_A, "F08-T6-Restart");
    const before = await q(
      A.db,
      `SELECT count(*)::int AS c FROM sync_outbox WHERE tenant_id=$1 AND status='pending'`,
      [TENANT_ID],
    );
    for (const s of servers.filter((x) => x.__name === "A")) s.kill("SIGKILL");
    await new Promise((r) => setTimeout(r, 1200));
    startServer("A", A.db, A.port, `http://127.0.0.1:${HUB.port}`, "f08-a-restart.log");
    await waitForHealth(A.port, "device A (restart)");
    const after = await q(
      A.db,
      `SELECT count(*)::int AS c FROM sync_outbox WHERE tenant_id=$1 AND status='pending'`,
      [TENANT_ID],
    );
    check(
      "pending units survived the restart",
      Number(before[0].c) > 0 && after[0].c === before[0].c,
      `before=${before[0].c} after=${after[0].c}`,
    );
  }

  // ---- T7: duplicate replay is idempotent ----
  section("T7. Duplicate replay is idempotent");
  {
    await syncUntilDrained(A.port, DEV_A);
    const hubBefore = await q(
      HUB.db,
      `SELECT count(*)::int AS c FROM invoices WHERE tenant_id=$1`,
      [TENANT_ID],
    );
    const first = await q(
      A.db,
      `SELECT op_id FROM sync_outbox WHERE tenant_id=$1 AND status='synced' ORDER BY seq LIMIT 1`,
      [TENANT_ID],
    );
    if (first.length > 0) {
      const c = await dbClient(A.db);
      await c.query(`UPDATE sync_outbox SET status='pending' WHERE tenant_id=$1 AND op_id=$2`, [
        TENANT_ID,
        first[0].op_id,
      ]);
      await c.end();
      await syncUntilDrained(A.port, DEV_A);
    }
    const hubAfter = await q(HUB.db, `SELECT count(*)::int AS c FROM invoices WHERE tenant_id=$1`, [
      TENANT_ID,
    ]);
    check(
      "replay did not duplicate hub invoices",
      Number(hubAfter[0].c) === Number(hubBefore[0].c),
      `before=${hubBefore[0].c} after=${hubAfter[0].c}`,
    );
  }

  // ---- T8: A/B convergence ----
  section("T8. Device A/B convergence");
  {
    const sA = await mkStock(A.port, DEV_A);
    const cA = await mkCustomer(A.port, DEV_A, "F08-T8-A");
    const invA = await mkSale(A.port, DEV_A, cA.id, {
      fabricId: sA.fab.id,
      colorId: sA.col.id,
      rollId: sA.roll.id,
      quantityKg: 3,
      pricePerKg: 1000,
    });
    const sB = await mkStock(B.port, DEV_B);
    const cB = await mkCustomer(B.port, DEV_B, "F08-T8-B");
    const invB = await mkSale(B.port, DEV_B, cB.id, {
      fabricId: sB.fab.id,
      colorId: sB.col.id,
      rollId: sB.roll.id,
      quantityKg: 3,
      pricePerKg: 1000,
    });
    const ok = invA.status === 201 && invB.status === 201;
    await syncUntilDrained(A.port, DEV_A);
    await syncUntilDrained(B.port, DEV_B);
    await syncUntilDrained(A.port, DEV_A);
    const hubA = await q(HUB.db, `SELECT id FROM invoices WHERE tenant_id=$1 AND id=$2`, [
      TENANT_ID,
      invA.json.id,
    ]);
    const hubB = await q(HUB.db, `SELECT id FROM invoices WHERE tenant_id=$1 AND id=$2`, [
      TENANT_ID,
      invB.json.id,
    ]);
    check(
      "both devices' invoices present on the hub",
      ok && hubA.length === 1 && hubB.length === 1,
      `A=${hubA.length} B=${hubB.length}`,
    );
  }

  // ---- T9: invoice cancel releases the roll claim ----
  section("T9. Invoice cancel releases the roll claim (roll can be resold)");
  {
    const stock = await mkStock(A.port, DEV_A);
    const cust = await mkCustomer(A.port, DEV_A, "F08-T9-Customer");
    const sale = await mkSale(A.port, DEV_A, cust.id, {
      fabricId: stock.fab.id,
      colorId: stock.col.id,
      rollId: stock.roll.id,
      quantityKg: 10,
      pricePerKg: 1000,
    });
    await syncUntilDrained(A.port, DEV_A);
    const cancel = await api(A.port, "POST", `/api/invoices/${sale.json.id}/cancel`, {
      deviceId: DEV_A,
      body: { expectedVersion: await versionOf(A.db, "invoices", sale.json.id) },
    });
    const cancelOk = cancel.status === 200 || cancel.status === 201;
    await syncUntilDrained(A.port, DEV_A);
    const claims = await q(
      HUB.db,
      `SELECT count(*)::int AS c FROM sync_resource_claims WHERE tenant_id=$1 AND resource_id=$2`,
      [TENANT_ID, stock.roll.id],
    );
    check(
      "roll claim released after cancel",
      cancelOk && Number(claims[0].c) === 0,
      `cancel=${cancel.status} claims=${claims[0].c}`,
    );
    const resale = await mkSale(A.port, DEV_A, cust.id, {
      fabricId: stock.fab.id,
      colorId: stock.col.id,
      rollId: stock.roll.id,
      quantityKg: 6,
      pricePerKg: 1000,
    });
    await syncUntilDrained(A.port, DEV_A);
    const hubResale = await q(HUB.db, `SELECT id FROM invoices WHERE tenant_id=$1 AND id=$2`, [
      TENANT_ID,
      resale.json?.id,
    ]);
    check(
      "roll resold after cancel",
      resale.status === 201 && hubResale.length === 1,
      `resale=${resale.status} hub=${hubResale.length}`,
    );
  }

  // ---- T10: out-of-order invoice defers until the roll exists ----
  section("T10. Out-of-order invoice defers, then applies");
  {
    const stock = await mkStock(A.port, DEV_A);
    const cust = await mkCustomer(A.port, DEV_A, "F08-T10-Customer");
    const sale = await mkSale(A.port, DEV_A, cust.id, {
      fabricId: stock.fab.id,
      colorId: stock.col.id,
      rollId: stock.roll.id,
      quantityKg: 5,
      pricePerKg: 1000,
    });
    const saleId = sale.json.id;
    const invUnit = await q(
      A.db,
      `SELECT op_id FROM sync_outbox WHERE tenant_id=$1 AND entity_id=$2`,
      [TENANT_ID, saleId],
    );
    let deferred = false;
    let applied = false;
    if (invUnit.length > 0) {
      const opId = invUnit[0].op_id;
      const local = await q(
        A.db,
        `SELECT payload FROM sync_outbox WHERE tenant_id=$1 AND op_id=$2`,
        [TENANT_ID, opId],
      );
      if (local.length > 0) {
        const raw = local[0].payload;
        const payload = typeof raw === "string" ? JSON.parse(raw) : raw;
        const direct = await api(HUB.port, "POST", "/api/sync/push", {
          deviceId: DEV_A,
          body: {
            opId: randomUUID(),
            syncDeviceId: DEV_A,
            entityType: "invoice",
            entityId: saleId,
            operation: "create",
            payload: {
              ...payload,
              invoiceId: saleId,
              preAllocated: false,
              actorUserId: USER_ID,
              actorRole: "admin",
              actorUserName: "Sync Admin",
            },
          },
        });
        const hubEarly = await q(HUB.db, `SELECT id FROM invoices WHERE tenant_id=$1 AND id=$2`, [
          TENANT_ID,
          saleId,
        ]);
        deferred = hubEarly.length === 0 || direct.status === 201;
        await syncUntilDrained(A.port, DEV_A);
        const hubLate = await q(HUB.db, `SELECT id FROM invoices WHERE tenant_id=$1 AND id=$2`, [
          TENANT_ID,
          saleId,
        ]);
        applied = hubLate.length === 1;
      }
    }
    check(
      "invoice deferred while deps missing, applied after arrival",
      deferred && applied,
      `deferred=${deferred} applied=${applied}`,
    );
  }

  // ---- T11: master update converges across devices ----
  // SYNC-13: A renames a party; the hub applies the rename and B pulls it.
  section("T11. Party rename converges to the hub and to device B");
  {
    const custA = await mkCustomer(A.port, DEV_A, "F08-T11-Base");
    await syncUntilDrained(A.port, DEV_A);
    await syncUntilDrained(B.port, DEV_B);
    const upd = await api(A.port, "PUT", `/api/customers/${custA.id}`, {
      deviceId: DEV_A,
      body: {
        name: "F08-T11-Renamed",
        expectedVersion: await versionOf(A.db, "parties", custA.id),
      },
    });
    check("rename accepted locally", upd.status === 200, `status=${upd.status}`);
    await syncUntilDrained(A.port, DEV_A);
    await syncUntilDrained(B.port, DEV_B);
    const hubName = await q(HUB.db, `SELECT name FROM parties WHERE tenant_id=$1 AND id=$2`, [
      TENANT_ID,
      custA.id,
    ]);
    const devBName = await q(B.db, `SELECT name FROM parties WHERE tenant_id=$1 AND id=$2`, [
      TENANT_ID,
      custA.id,
    ]);
    check(
      "hub and device B carry the rename",
      hubName[0]?.name === "F08-T11-Renamed" && devBName[0]?.name === "F08-T11-Renamed",
      `hub=${hubName[0]?.name} B=${devBName[0]?.name}`,
    );
  }

  // ---- T12: concurrent master edits serialize ----
  section("T12. Concurrent party renames serialize (one winner, loser flagged)");
  {
    const custA = await mkCustomer(A.port, DEV_A, "F08-T12-Base");
    await syncUntilDrained(A.port, DEV_A);
    await syncUntilDrained(B.port, DEV_B);
    const [vA, vB] = [
      await versionOf(A.db, "parties", custA.id),
      await versionOf(B.db, "parties", custA.id),
    ];
    const [uA, uB] = await Promise.all([
      api(A.port, "PUT", `/api/customers/${custA.id}`, {
        deviceId: DEV_A,
        body: { name: "F08-T12-A", expectedVersion: vA },
      }),
      api(B.port, "PUT", `/api/customers/${custA.id}`, {
        deviceId: DEV_B,
        body: { name: "F08-T12-B", expectedVersion: vB },
      }),
    ]);
    check(
      "both renames accepted locally",
      uA.status === 200 && uB.status === 200,
      `A=${uA.status} B=${uB.status}`,
    );
    const runA = await syncUntilDrained(A.port, DEV_A);
    const runB = await syncUntilDrained(B.port, DEV_B);
    const totalRejected = [...runA, ...runB].reduce((n, r) => n + (r.rejected ?? 0), 0);
    const hubName = await q(HUB.db, `SELECT name FROM parties WHERE tenant_id=$1 AND id=$2`, [
      TENANT_ID,
      custA.id,
    ]);
    const winner = hubName[0]?.name;
    check(
      "exactly one rename won and the loser was rejected (not silently overwritten)",
      (winner === "F08-T12-A" || winner === "F08-T12-B") && totalRejected === 1,
      `winner=${winner} rejected=${totalRejected}`,
    );
  }

  // ---- T13: order update converges ----
  section("T13. Order notes edit converges to the hub");
  {
    const custA = await mkCustomer(A.port, DEV_A, "F08-T13-Customer");
    await syncUntilDrained(A.port, DEV_A);
    const ord = await api(A.port, "POST", "/api/orders", {
      deviceId: DEV_A,
      body: {
        customerNameSnapshot: "F08-T13",
        date: "2026-01-15",
        notes: "before",
        items: [{ fabricName: "قماش", colorName: "لون", requestedKg: 5 }],
      },
    });
    check("order created locally", ord.status === 201, `status=${ord.status}`);
    const orderId = ord.json?.id;
    await syncUntilDrained(A.port, DEV_A);
    const upd = await api(A.port, "PUT", `/api/orders/${orderId}`, {
      deviceId: DEV_A,
      body: {
        notes: "F08-T13-after",
        expectedVersion: await versionOf(A.db, "orders", orderId),
      },
    });
    check("order edit accepted locally", upd.status === 200, `status=${upd.status}`);
    await syncUntilDrained(A.port, DEV_A);
    const hubNotes = await q(HUB.db, `SELECT notes FROM orders WHERE tenant_id=$1 AND id=$2`, [
      TENANT_ID,
      orderId,
    ]);
    check(
      "hub carries the edited notes",
      hubNotes[0]?.notes === "F08-T13-after",
      `notes=${hubNotes[0]?.notes}`,
    );
  }

  // ---- T14: direct ledger batch converges id-keyed ----
  section("T14. Direct ledger batch reaches the hub exactly once");
  {
    const custA = await mkCustomer(A.port, DEV_A, "F08-T14-Customer");
    await syncUntilDrained(A.port, DEV_A);
    const posted = await api(A.port, "POST", "/api/ledger", {
      deviceId: DEV_A,
      body: {
        entries: [
          {
            partyId: custA.id,
            date: "2026-01-15",
            type: "adjustment",
            debit: 7000,
            currency: "SYP",
            description: "F08-T14-a",
          },
          {
            partyId: custA.id,
            date: "2026-01-15",
            type: "adjustment",
            credit: 7000,
            currency: "SYP",
            description: "F08-T14-b",
          },
        ],
      },
    });
    check("ledger batch accepted locally", posted.status === 201, `status=${posted.status}`);
    await syncUntilDrained(A.port, DEV_A);
    await syncUntilDrained(B.port, DEV_B);
    const hubLegs = await q(
      HUB.db,
      `SELECT count(*)::int AS c FROM ledger_entries WHERE tenant_id=$1 AND description IN ('F08-T14-a','F08-T14-b')`,
      [TENANT_ID],
    );
    const devBLegs = await q(
      B.db,
      `SELECT count(*)::int AS c FROM ledger_entries WHERE tenant_id=$1 AND description IN ('F08-T14-a','F08-T14-b')`,
      [TENANT_ID],
    );
    check(
      "hub and device B carry both legs exactly once (no duplication on replay)",
      hubLegs[0]?.c === 2 && devBLegs[0]?.c === 2,
      `hub=${hubLegs[0]?.c} B=${devBLegs[0]?.c}`,
    );
  }

  // ---- T15: settlement clash — one winner, loser reversed locally ----
  section("T15. Concurrent settlements serialize (loser reversed by reference)");
  {
    const stock = await mkStock(A.port, DEV_A);
    const custA = await mkCustomer(A.port, DEV_A, "F08-T15-Customer");
    await syncUntilDrained(A.port, DEV_A);
    await syncUntilDrained(B.port, DEV_B);
    const sale = await mkSale(A.port, DEV_A, custA.id, {
      fabricId: stock.fab.id,
      colorId: stock.col.id,
      rollId: stock.roll.id,
      quantityKg: 10,
      pricePerKg: 1000,
    });
    check("sale created locally", sale.status === 201, `status=${sale.status}`);
    await syncUntilDrained(A.port, DEV_A);
    await syncUntilDrained(B.port, DEV_B);
    const [sA, sB] = await Promise.all([
      api(A.port, "POST", `/api/customers/${custA.id}/statement/settle`, {
        deviceId: DEV_A,
        body: { date: "2026-01-16" },
      }),
      api(B.port, "POST", `/api/customers/${custA.id}/statement/settle`, {
        deviceId: DEV_B,
        body: { date: "2026-01-16" },
      }),
    ]);
    check(
      "both settles accepted locally",
      sA.status === 201 && sB.status === 201,
      `A=${sA.status} B=${sB.status}`,
    );
    const runA = await syncUntilDrained(A.port, DEV_A);
    const runB = await syncUntilDrained(B.port, DEV_B);
    await syncUntilDrained(A.port, DEV_A);
    await syncUntilDrained(B.port, DEV_B);
    const totalRejected = [...runA, ...runB].reduce((n, r) => n + (r.rejected ?? 0), 0);
    const hubSettles = await q(
      HUB.db,
      `SELECT count(*)::int AS c FROM ledger_entries WHERE tenant_id=$1 AND reference_type='settlement' AND (party_id=$2 OR party_id IS NULL)`,
      [TENANT_ID, custA.id],
    );
    check(
      "exactly one settlement won on the hub and the loser was reconciled",
      hubSettles[0]?.c === 2 && totalRejected === 1,
      `legs=${hubSettles[0]?.c} rejected=${totalRejected}`,
    );
  }

  // ---- T16: day-close clash — one winner per date ----
  section("T16. Concurrent day-closes serialize (one winner per date)");
  {
    const [cA, cB] = await Promise.all([
      api(A.port, "POST", "/api/cashbox/close-day", {
        deviceId: DEV_A,
        body: { date: "2026-01-20", counted: 1000 },
      }),
      api(B.port, "POST", "/api/cashbox/close-day", {
        deviceId: DEV_B,
        body: { date: "2026-01-20", counted: 1000 },
      }),
    ]);
    check(
      "both closes accepted locally",
      cA.status === 201 && cB.status === 201,
      `A=${cA.status} B=${cB.status}`,
    );
    const runA = await syncUntilDrained(A.port, DEV_A);
    const runB = await syncUntilDrained(B.port, DEV_B);
    await syncUntilDrained(A.port, DEV_A);
    await syncUntilDrained(B.port, DEV_B);
    const totalRejected = [...runA, ...runB].reduce((n, r) => n + (r.rejected ?? 0), 0);
    const hubCloses = await q(
      HUB.db,
      `SELECT count(*)::int AS c FROM day_closes WHERE tenant_id=$1 AND date='2026-01-20'`,
      [TENANT_ID],
    );
    const devBCloses = await q(
      B.db,
      `SELECT count(*)::int AS c FROM day_closes WHERE tenant_id=$1 AND date='2026-01-20'`,
      [TENANT_ID],
    );
    check(
      "hub holds exactly one close for the date and both devices converge",
      hubCloses[0]?.c === 1 && totalRejected === 1 && devBCloses[0]?.c === 1,
      `hub=${hubCloses[0]?.c} rejected=${totalRejected} B=${devBCloses[0]?.c}`,
    );
  }

  // ---- T17: manual movement converges ----
  section("T17. Manual cash movement converges to hub and device B");
  {
    const mv = await api(A.port, "POST", "/api/cashbox/manual-movements", {
      deviceId: DEV_A,
      body: {
        date: "2026-01-21",
        type: "adjustment",
        direction: "in",
        amount: 2500,
        description: "F08-T17",
      },
    });
    check("movement accepted locally", mv.status === 201, `status=${mv.status}`);
    await syncUntilDrained(A.port, DEV_A);
    await syncUntilDrained(B.port, DEV_B);
    const hubMv = await q(
      HUB.db,
      `SELECT count(*)::int AS c FROM manual_movements WHERE tenant_id=$1 AND description='F08-T17'`,
      [TENANT_ID],
    );
    const devBMv = await q(
      B.db,
      `SELECT count(*)::int AS c FROM manual_movements WHERE tenant_id=$1 AND description='F08-T17'`,
      [TENANT_ID],
    );
    check(
      "hub and device B carry the movement exactly once",
      hubMv[0]?.c === 1 && devBMv[0]?.c === 1,
      `hub=${hubMv[0]?.c} B=${devBMv[0]?.c}`,
    );
  }

  // ---- T18: settings snapshot converges ----
  section("T18. Settings edit converges hub-wins to device B");
  {
    const upd = await api(A.port, "PUT", "/api/settings/printing", {
      deviceId: DEV_A,
      body: { paper: "F08-T18" },
    });
    check("settings edit accepted locally", upd.status === 200, `status=${upd.status}`);
    await syncUntilDrained(A.port, DEV_A);
    await syncUntilDrained(B.port, DEV_B);
    const devBPrinting = await q(B.db, `SELECT printing FROM settings WHERE tenant_id=$1`, [
      TENANT_ID,
    ]);
    const val = devBPrinting[0]?.printing;
    const parsed = typeof val === "string" ? JSON.parse(val) : val;
    check(
      "device B carries the edited settings",
      parsed?.paper === "F08-T18",
      `B=${JSON.stringify(parsed)?.slice(0, 80)}`,
    );
  }

  // ---- T19: device gate — unknown devices are refused pre-work ----
  section("T19. Unknown device pushes are refused before any sync work");
  {
    const ghost = randomUUID();
    const refused = await api(HUB.port, "POST", "/api/sync/push", {
      deviceId: ghost,
      body: {
        opId: randomUUID(),
        syncDeviceId: ghost,
        entityType: "expense",
        entityId: randomUUID(),
        operation: "create",
        payload: {},
      },
    });
    check(
      "hub refuses the unknown device with SYNC_UNKNOWN_DEVICE",
      refused.status === 403 && refused.json?.code === "SYNC_UNKNOWN_DEVICE",
      `status=${refused.status} code=${refused.json?.code}`,
    );
    const inboxRows = await q(
      HUB.db,
      `SELECT count(*)::int AS c FROM sync_inbox WHERE tenant_id=$1 AND sync_device_id=$2`,
      [TENANT_ID, ghost],
    );
    check(
      "refused push left no inbox row (rejected pre-work, nothing to triage)",
      inboxRows[0]?.c === 0,
      `rows=${inboxRows[0]?.c}`,
    );
  }

  // ---- T20: lanes — independent docs drain concurrently, same-doc chains stay ordered ----
  section("T20. Push lanes: 4 independent sales + 1 order edit chain converge");
  {
    const custA = await mkCustomer(A.port, DEV_A, "F08-T20-Customer");
    await syncUntilDrained(A.port, DEV_A);
    const rolls = [];
    for (let i = 0; i < 4; i++) rolls.push(await mkStock(A.port, DEV_A, 5000, 500, 5));
    const sales = [];
    for (const s of rolls) {
      sales.push(
        await mkSale(A.port, DEV_A, custA.id, {
          fabricId: s.fab.id,
          colorId: s.col.id,
          rollId: s.roll.id,
          quantityKg: 7,
          pricePerKg: 1000,
        }),
      );
    }
    const ord = await api(A.port, "POST", "/api/orders", {
      deviceId: DEV_A,
      body: {
        customerNameSnapshot: "F08-T20",
        date: "2026-01-15",
        notes: "lane-before",
        items: [{ fabricName: "قماش", colorName: "لون", requestedKg: 5 }],
      },
    });
    const orderId = ord.json?.id;
    const upd = await api(A.port, "PUT", `/api/orders/${orderId}`, {
      deviceId: DEV_A,
      body: {
        notes: "lane-after",
        expectedVersion: await versionOf(A.db, "orders", orderId),
      },
    });
    const localOk =
      sales.every((s) => s.status === 201) && ord.status === 201 && upd.status === 200;
    check(
      "all units created/edited locally",
      localOk,
      `sales=${sales.map((s) => s.status)} ord=${ord.status} upd=${upd.status}`,
    );
    await syncUntilDrained(A.port, DEV_A);
    await syncUntilDrained(B.port, DEV_B);
    const hubSales = await q(
      HUB.db,
      `SELECT count(*)::int AS c, coalesce(sum(total),0)::int AS t FROM invoices WHERE tenant_id=$1 AND id = ANY($2)`,
      [TENANT_ID, sales.map((s) => s.json.id)],
    );
    const hubNotes = await q(HUB.db, `SELECT notes FROM orders WHERE tenant_id=$1 AND id=$2`, [
      TENANT_ID,
      orderId,
    ]);
    const hubKg = await q(
      HUB.db,
      `SELECT coalesce(sum(5000 - remaining_kg),0)::int AS d FROM rolls WHERE tenant_id=$1 AND id = ANY($2)`,
      [TENANT_ID, rolls.map((s) => s.roll.id)],
    );
    check(
      "all 4 lane-pushed sales applied with exact stock (4x7=28)",
      hubSales[0]?.c === 4 && Number(hubKg[0]?.d) === 28,
      `sales=${hubSales[0]?.c} deducted=${hubKg[0]?.d}`,
    );
    check(
      "same-document order chain kept order (edit applied after create)",
      hubNotes[0]?.notes === "lane-after",
      `notes=${hubNotes[0]?.notes}`,
    );
  }

  // ---- T21: number-block tip reconciliation (fallback numbers never collide) ----
  section("T21. Hub block claim reconciles the device's fallback-issued tip");
  {
    // knownUsed far above any tip this run could have produced: without
    // reconciliation the hub would carve near its own tip (~1000); with it,
    // the carved range starts above knownUsed.
    const reconciled = await api(HUB.port, "POST", "/api/sync/number-blocks/claim", {
      deviceId: DEV_A,
      body: { syncDeviceId: DEV_A, entityType: "supplier", size: 5, knownUsed: 8000 },
    });
    check(
      "hub carves above the device-reported tip",
      reconciled.status === 201 && reconciled.json?.startNumber > 8000,
      `status=${reconciled.status} start=${reconciled.json?.startNumber}`,
    );
    const plain = await api(HUB.port, "POST", "/api/sync/number-blocks/claim", {
      deviceId: DEV_A,
      body: { syncDeviceId: DEV_A, entityType: "expense", size: 5 },
    });
    check(
      "claim without knownUsed still works (backward compatible)",
      plain.status === 201 && typeof plain.json?.startNumber === "number",
      `status=${plain.status} start=${plain.json?.startNumber}`,
    );
  }

  // ------------------------------------------------------------------
  const passed = results.filter((r) => r.pass).length;
  section("Summary");
  console.log(`  ${passed}/${results.length} checks passed`);
  if (passed !== results.length) {
    console.log("\n  Failures:");
    for (const r of results.filter((x) => !x.pass)) console.log(`   - ${r.name} (${r.detail})`);
  }
  return passed === results.length ? 0 : 1;
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (err) {
  console.error("\nHARNESS ERROR:", err);
} finally {
  await stopAllServers();
  if (!KEEP) {
    try {
      const c = await adminClient();
      for (const { db } of [HUB, A, B]) {
        await c.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`).catch(() => {});
      }
      await c.end();
      console.log("\n(databases dropped; pass --keep to retain them)");
    } catch {
      /* ignore */
    }
  }
}
process.exit(exitCode);
