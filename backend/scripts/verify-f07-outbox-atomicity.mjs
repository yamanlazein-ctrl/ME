/**
 * F-07 — Transactional Outbox: business write + outbox enqueue atomicity.
 *
 * THE INVARIANT UNDER TEST
 *   "Every successful offline business mutation must have a durable
 *    corresponding outbox operation in the same transaction."
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
 * Usage:  node scripts/verify-f07-outbox-atomicity.mjs --keep
 */
import pg from "pg";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";

const BACKEND = path.resolve(import.meta.dirname, "..");
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
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
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

async function waitForHealth(port, label, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  let lastErr = "";
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health/live`, { signal: AbortSignal.timeout(2000) });
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
    if (fs.existsSync(p) && fs.statSync(p).size > 0) tail += `\n----- ${f} -----\n${fs.readFileSync(p, "utf8").slice(-3000)}`;
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
  return new SignJWT({ sub: USER_ID, tenantId: TENANT_ID, role: "admin", jti: randomUUID(), type: "access" })
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
  Number((await q(db, `SELECT count(*)::int AS c FROM ${table} WHERE tenant_id = $1 AND id = $2`, [TENANT_ID, entityId]))[0].c);

const outboxFor = async (db, entityId) =>
  q(db, `SELECT op_id, entity_type, entity_id, operation, status FROM sync_outbox
         WHERE tenant_id = $1 AND entity_id = $2`, [TENANT_ID, entityId]);

/** Build a stock chain (fabric → color → roll) so a sale invoice can be created. */
async function mkStock(port, deviceId, kg = 5000, cost = 500) {
  const u = randomUUID().slice(0, 8);
  const fab = (await api(port, "POST", "/api/inventory/fabrics", { deviceId, body: { name: `قماش ${u}` } })).json;
  const col = (await api(port, "POST", "/api/inventory/colors", { deviceId, body: { fabricId: fab.id, name: `لون ${u}`, code: `C${u}` } })).json;
  const roll = (await api(port, "POST", "/api/inventory/rolls", {
    deviceId,
    body: { colorId: col.id, rollNo: `R-${u}`, initialKg: kg, remainingKg: kg, pricePerKg: cost, entryDate: "2026-01-15" },
  })).json;
  return { fab, col, roll };
}

async function mkCustomer(port, deviceId, name) {
  return (await api(port, "POST", "/api/customers", { deviceId, body: { name } })).json;
}

/** Loop sync/run until nothing is pushed and nothing new is pulled. */
async function syncUntilDrained(port, deviceId, maxRounds = 8) {
  const rounds = [];
  for (let i = 0; i < maxRounds; i += 1) {
    const r = await api(port, "POST", "/api/sync/run", { deviceId });
    rounds.push(r.json ?? { status: r.status });
    if (r.status !== 200) break;
    const j = r.json;
    const noPush = (j.pushed ?? 0) === 0 && (j.failed ?? 0) === 0 && (j.rejected ?? 0) === 0;
    const noPull = (j.pull?.pulled ?? 0) === 0;
    if (noPush && noPull) break;
  }
  return rounds;
}

// ------------------------------------------------------------------ main

async function main() {
  console.log("F-07 — Transactional Outbox atomicity verification\n");

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
  section("0c. Provision reserved number blocks while online");
  // Offline document creation draws from a device-reserved block; without one,
  // `allocateDocumentNumber` fails closed (by design — a local fallback would
  // collide globally). The real Desktop flow provisions these at login.
  for (const [label, port, dev] of [
    ["device A", A.port, DEV_A],
    ["device B", B.port, DEV_B],
  ]) {
    const r = await api(port, "POST", "/api/sync/number-blocks/ensure", {
      deviceId: dev,
      body: { syncDeviceId: dev },
    });
    check(`${label} reserved its number blocks`, r.status === 200, `HTTP ${r.status} ${r.text.slice(0, 160)}`);
  }

  // ------------------------------------------------------------------
  section("1. Baseline: an offline write creates BOTH the document and its outbox unit");
  const cust1 = await mkCustomer(A.port, DEV_A, "F07-Customer-1");
  const docRows1 = await countWhere(A.db, "parties", cust1.id);
  const obRows1 = await outboxFor(A.db, cust1.id);
  check(
    "the business row exists after a successful write",
    docRows1 === 1,
    `parties rows = ${docRows1}`,
  );
  check(
    "a durable outbox unit exists for the same entity (same transaction)",
    obRows1.length === 1 && obRows1[0].entity_type === "party" && obRows1[0].status === "pending",
    `outbox = ${JSON.stringify(obRows1)}`,
  );

  // ------------------------------------------------------------------
  section("2. Failure injection: outbox insert fails → business write must roll back");

  // Sentinel op-id injected into the request's Idempotency-Key, which the route
  // forwards as the outbox op-id.
  const sentinelOp = randomUUID();
  await installOutboxFailureTrigger(A.db, sentinelOp);

  // A rolled-back write must not consume a document number either (the counter
  // moves inside the same transaction). Numbers now come from the device's
  // reserved BLOCK, so both the block cursor and the shared sequence tip are
  // captured before the failing request — the previous version of this check
  // hard-coded the pre-block model (a shared sequence starting at 1) and could
  // never pass once number blocks were provisioned.
  const seqBefore = await q(
    A.db,
    `SELECT entity_type, last_number::bigint AS last_number FROM document_sequences
      WHERE tenant_id = $1 ORDER BY entity_type`,
    [TENANT_ID],
  );
  const blocksBefore = await q(
    A.db,
    `SELECT entity_type, next_number::bigint AS next_number FROM document_number_blocks
      WHERE tenant_id = $1 ORDER BY entity_type`,
    [TENANT_ID],
  );

  const failCust = await api(A.port, "POST", "/api/customers", {
    deviceId: DEV_A,
    headers: { "Idempotency-Key": sentinelOp },
    body: { name: "F07-Must-Rollback" },
  });

  check(
    "the request FAILS (no false local success) instead of returning 201",
    failCust.status >= 500,
    `HTTP ${failCust.status} body=${failCust.text.slice(0, 200)}`,
  );
  check(
    "the failure carries the explicit sync-outbox error code",
    failCust.json?.code === "SYNC_OUTBOX_FAILED",
    `code=${failCust.json?.code}`,
  );

  const rolledBackParties = await q(
    A.db,
    `SELECT id, name FROM parties WHERE tenant_id = $1 AND name = 'F07-Must-Rollback'`,
    [TENANT_ID],
  );
  check(
    "BUSINESS ROLLBACK: no party row survived the failed outbox insert",
    rolledBackParties.length === 0,
    `parties matching name = ${rolledBackParties.length}`,
  );

  const rolledBackOutbox = await q(
    A.db,
    `SELECT op_id FROM sync_outbox WHERE tenant_id = $1 AND op_id = $2`,
    [TENANT_ID, sentinelOp],
  );
  check(
    "no outbox unit survived either",
    rolledBackOutbox.length === 0,
    `outbox rows for sentinel = ${rolledBackOutbox.length}`,
  );

  // The document number the rolled-back party would have consumed must not have
  // been burned either — the numbering counter lives inside the same tx.
  const seqAfterFail = await q(
    A.db,
    `SELECT entity_type, last_number::bigint AS last_number FROM document_sequences
      WHERE tenant_id = $1 ORDER BY entity_type`,
    [TENANT_ID],
  );
  const blocksAfterFail = await q(
    A.db,
    `SELECT entity_type, next_number::bigint AS next_number FROM document_number_blocks
      WHERE tenant_id = $1 ORDER BY entity_type`,
    [TENANT_ID],
  );
  check(
    "the rolled-back write did not burn a document number (block cursor + shared tip unchanged)",
    JSON.stringify(seqAfterFail) === JSON.stringify(seqBefore) &&
      JSON.stringify(blocksAfterFail) === JSON.stringify(blocksBefore),
    `seq before=${JSON.stringify(seqBefore)} after=${JSON.stringify(seqAfterFail)} | ` +
      `blocks before=${JSON.stringify(blocksBefore)} after=${JSON.stringify(blocksAfterFail)}`,
  );

  await removeOutboxFailureTrigger(A.db);

  // ------------------------------------------------------------------
  section("3. Recovery: the same operation succeeds once the outbox is healthy again");
  const recoveredCust = await api(A.port, "POST", "/api/customers", {
    deviceId: DEV_A,
    body: { name: "F07-Recovered" },
  });
  check("the retried write succeeds (HTTP 201)", recoveredCust.status === 201, `HTTP ${recoveredCust.status}`);
  const recRows = await countWhere(A.db, "parties", recoveredCust.json.id);
  const recOutbox = await outboxFor(A.db, recoveredCust.json.id);
  check(
    "SUCCESSFUL ATOMICITY: document + outbox unit both present",
    recRows === 1 && recOutbox.length === 1,
    `parties=${recRows} outbox=${JSON.stringify(recOutbox)}`,
  );

  // ------------------------------------------------------------------
  section("4. Sale invoice through the full business path (stock + ledger + outbox)");
  const stock = await mkStock(A.port, DEV_A);
  const saleCust = await mkCustomer(A.port, DEV_A, "F07-Sale-Customer");
  const sale = await api(A.port, "POST", "/api/invoices", {
    deviceId: DEV_A,
    body: {
      type: "sale",
      date: "2026-01-15",
      partyId: saleCust.id,
      partyType: "customer",
      currency: "SYP",
      exchangeRate: 15000,
      lines: [{ fabricId: stock.fab.id, colorId: stock.col.id, rollId: stock.roll.id, quantityKg: 10, pricePerKg: 1000 }],
    },
  });
  check("the sale invoice was created", sale.status === 201, `HTTP ${sale.status} ${sale.text.slice(0, 160)}`);
  const invOutbox = await outboxFor(A.db, sale.json.id);
  check(
    "the invoice has its durable outbox unit",
    invOutbox.length === 1 && invOutbox[0].entity_type === "invoice",
    `outbox=${JSON.stringify(invOutbox)}`,
  );

  // Rollback proof on the FULL business path: the invoice transaction writes
  // stock movements + double-entry ledger legs + the outbox unit. Injecting an
  // outbox failure must leave NONE of them.
  const sentinelInvOp = randomUUID();
  await installOutboxFailureTrigger(A.db, sentinelInvOp);
  const stock2 = await mkStock(A.port, DEV_A);
  const cust2 = await mkCustomer(A.port, DEV_A, "F07-Sale-Rollback");
  const kgBefore = Number(
    (await q(A.db, `SELECT remaining_kg FROM rolls WHERE tenant_id = $1 AND id = $2`, [TENANT_ID, stock2.roll.id]))[0].remaining_kg,
  );
  const failedSale = await api(A.port, "POST", "/api/invoices", {
    deviceId: DEV_A,
    headers: { "Idempotency-Key": sentinelInvOp },
    body: {
      type: "sale",
      date: "2026-01-15",
      partyId: cust2.id,
      partyType: "customer",
      currency: "SYP",
      exchangeRate: 15000,
      lines: [{ fabricId: stock2.fab.id, colorId: stock2.col.id, rollId: stock2.roll.id, quantityKg: 10, pricePerKg: 1000 }],
    },
  });
  check("the failing invoice request returns an error", failedSale.status >= 500, `HTTP ${failedSale.status}`);
  check(
    "the failing invoice reports the sync-outbox error code",
    failedSale.json?.code === "SYNC_OUTBOX_FAILED",
    `code=${failedSale.json?.code}`,
  );

  const invLeft = await q(
    A.db,
    `SELECT i.id FROM invoices i WHERE i.tenant_id = $1 AND i.party_id = $2`,
    [TENANT_ID, cust2.id],
  );
  check("BUSINESS ROLLBACK: no invoice row survived", invLeft.length === 0, `invoices = ${invLeft.length}`);

  const kgAfter = Number(
    (await q(A.db, `SELECT remaining_kg FROM rolls WHERE tenant_id = $1 AND id = $2`, [TENANT_ID, stock2.roll.id]))[0].remaining_kg,
  );
  check(
    "INVENTORY ROLLBACK: stock was not deducted by the failed invoice",
    kgAfter === kgBefore,
    `remaining_kg before=${kgBefore} after=${kgAfter}`,
  );

  const ledgers = await q(
    A.db,
    `SELECT id FROM ledger_entries WHERE tenant_id = $1 AND party_id = $2`,
    [TENANT_ID, cust2.id],
  );
  check("LEDGER ROLLBACK: no ledger legs were left behind", ledgers.length === 0, `ledger rows = ${ledgers.length}`);

  const movements = await q(
    A.db,
    `SELECT id FROM stock_movements WHERE tenant_id = $1 AND roll_id = $2 AND movement_type = 'invoice_sale'`,
    [TENANT_ID, stock2.roll.id],
  );
  check("STOCK MOVEMENT ROLLBACK: no sale movement was left behind", movements.length === 0, `movements = ${movements.length}`);

  await removeOutboxFailureTrigger(A.db);

  // ------------------------------------------------------------------
  section("4b. Company profile (PUT /api/company/profile) — same-transaction guarantee");
  // The route used to upsert the profile (in the repository's own transaction)
  // and then insert the outbox unit AFTERWARDS inside a log-only try/catch, so a
  // failed enqueue left a saved profile with no sync unit. It is also the path
  // that proves the `withTenantTx` re-entrancy fix: the repository opens its own
  // transaction internally and must JOIN the route's one as a savepoint.
  const beforeProfile = await q(
    A.db,
    `SELECT name FROM company_profiles WHERE tenant_id = $1`,
    [TENANT_ID],
  );
  const sentinelCompanyOp = randomUUID();
  await installOutboxFailureTrigger(A.db, sentinelCompanyOp);
  const failedProfile = await api(A.port, "PUT", "/api/company/profile", {
    deviceId: DEV_A,
    headers: { "Idempotency-Key": sentinelCompanyOp },
    body: { name: "F07-Company-Must-Rollback" },
  });
  check(
    "the profile request FAILS instead of returning a silent local success",
    failedProfile.status >= 500,
    `HTTP ${failedProfile.status} body=${failedProfile.text.slice(0, 200)}`,
  );
  check(
    "the profile failure carries the sync-outbox error code",
    failedProfile.json?.code === "SYNC_OUTBOX_FAILED",
    `code=${failedProfile.json?.code}`,
  );
  const afterProfile = await q(
    A.db,
    `SELECT name FROM company_profiles WHERE tenant_id = $1`,
    [TENANT_ID],
  );
  check(
    "BUSINESS ROLLBACK: the company profile was not written by the failed request",
    afterProfile.length === beforeProfile.length &&
      afterProfile.every((r, i) => r.name === beforeProfile[i]?.name),
    `before=${JSON.stringify(beforeProfile)} after=${JSON.stringify(afterProfile)}`,
  );
  await removeOutboxFailureTrigger(A.db);

  const okProfile = await api(A.port, "PUT", "/api/company/profile", {
    deviceId: DEV_A,
    body: { name: "F07-Company-OK" },
  });
  check(
    "the profile write succeeds once the outbox is healthy",
    okProfile.status === 200 && okProfile.json?.name === "F07-Company-OK",
    `HTTP ${okProfile.status}`,
  );
  const profileOutbox = await q(
    A.db,
    `SELECT operation, status FROM sync_outbox WHERE tenant_id = $1 AND entity_type = 'company'`,
    [TENANT_ID],
  );
  check(
    "the profile has its durable outbox unit in the same transaction",
    profileOutbox.length === 1 && profileOutbox[0].operation === "update" && profileOutbox[0].status === "pending",
    `outbox = ${JSON.stringify(profileOutbox)}`,
  );

  // ------------------------------------------------------------------
  section("4c. Ledger and cashbox writes join the route transaction");
  // These routes wrapped "business write + enqueue" in `withTenantTx`, but their
  // repositories were wired with the RAW pool handle, so the business write ran
  // on a second connection and committed independently of the outbox row.
  const sentinelLedgerOp = randomUUID();
  await installOutboxFailureTrigger(A.db, sentinelLedgerOp);
  const ledgerBefore = await q(
    A.db,
    `SELECT id FROM ledger_entries WHERE tenant_id = $1 AND reference_type = 'manual'`,
    [TENANT_ID],
  );
  // The payload must be VALID — double-entry balanced per currency and a real
  // partyId — so the ONLY reason the request can fail is the injected
  // outbox-insert failure; otherwise a 422 would masquerade as proof of
  // atomicity.
  const failedLedger = await api(A.port, "POST", "/api/ledger", {
    deviceId: DEV_A,
    headers: { "Idempotency-Key": sentinelLedgerOp },
    body: {
      entries: [
        {
          partyId: cust1.id,
          date: "2026-01-15",
          type: "adjustment",
          debit: 100,
          credit: 0,
          currency: "SYP",
          cashImpact: "none",
          referenceType: "manual",
          referenceId: randomUUID(),
          description: "F-07 ledger rollback probe (debit leg)",
        },
        {
          partyId: cust1.id,
          date: "2026-01-15",
          type: "adjustment",
          debit: 0,
          credit: 100,
          currency: "SYP",
          cashImpact: "none",
          referenceType: "manual",
          referenceId: randomUUID(),
          description: "F-07 ledger rollback probe (credit leg)",
        },
      ],
    },
  });
  check(
    "the direct ledger write FAILS when its outbox unit cannot be written",
    failedLedger.status >= 500 && failedLedger.json?.code === "INTERNAL",
    `HTTP ${failedLedger.status} ${failedLedger.text.slice(0, 160)}`,
  );
  const ledgerAfter = await q(
    A.db,
    `SELECT id FROM ledger_entries WHERE tenant_id = $1 AND reference_type = 'manual'`,
    [TENANT_ID],
  );
  check(
    "LEDGER ROLLBACK: no ledger row survived the failed outbox insert",
    ledgerAfter.length === ledgerBefore.length,
    `before=${ledgerBefore.length} after=${ledgerAfter.length}`,
  );
  await removeOutboxFailureTrigger(A.db);

  const sentinelCashboxOp = randomUUID();
  await installOutboxFailureTrigger(A.db, sentinelCashboxOp);
  const failedCashbox = await api(A.port, "POST", "/api/cashbox/manual-movements", {
    deviceId: DEV_A,
    headers: { "Idempotency-Key": sentinelCashboxOp },
    body: {
      date: "2026-01-16",
      type: "capital",
      direction: "in",
      amount: 5000,
      currency: "SYP",
      description: "F-07 cashbox rollback probe",
    },
  });
  const cashboxAfter = await q(
    A.db,
    `SELECT id FROM manual_movements WHERE tenant_id = $1 AND date = '2026-01-16'`,
    [TENANT_ID],
  );
  check(
    "CASHBOX ROLLBACK: no manual movement survived the failed outbox insert",
    failedCashbox.status >= 500 && cashboxAfter.length === 0,
    `HTTP ${failedCashbox.status} movements=${cashboxAfter.length}`,
  );
  await removeOutboxFailureTrigger(A.db);

  // ------------------------------------------------------------------
  section("5. DB SELECT: no business mutation exists without its outbox operation");
  // The invariant, expressed as a query the database itself answers.
  //
  // Scope matters: only LOCALLY-ORIGINATED mutations must have an outbox unit.
  // A row that arrived by PULL (replay of a peer's unit) legitimately has an
  // inbox row and NO outbox row — that is the inbound half of the engine, not a
  // lost write. Both conditions are required for the invariant to be meaningful.
  const ORPHAN_SQL = `
    SELECT 'party' AS entity_type, p.id::text AS entity_id
      FROM parties p
     WHERE p.tenant_id = $1
       AND NOT EXISTS (SELECT 1 FROM sync_outbox o WHERE o.tenant_id = p.tenant_id AND o.entity_id = p.id)
       AND NOT EXISTS (SELECT 1 FROM sync_inbox  i WHERE i.tenant_id = p.tenant_id AND i.entity_id = p.id)
    UNION ALL
    SELECT 'invoice', i.id::text FROM invoices i
     WHERE i.tenant_id = $1
       AND NOT EXISTS (SELECT 1 FROM sync_outbox o WHERE o.tenant_id = i.tenant_id AND o.entity_id = i.id)
       AND NOT EXISTS (SELECT 1 FROM sync_inbox  b WHERE b.tenant_id = i.tenant_id AND b.entity_id = i.id)
    UNION ALL
    SELECT 'roll', r.id::text FROM rolls r
     WHERE r.tenant_id = $1
       AND NOT EXISTS (SELECT 1 FROM sync_outbox o WHERE o.tenant_id = r.tenant_id AND o.entity_id = r.id)
       AND NOT EXISTS (SELECT 1 FROM sync_inbox  b WHERE b.tenant_id = r.tenant_id AND b.entity_id = r.id)
    UNION ALL
    SELECT 'fabric', f.id::text FROM fabrics f
     WHERE f.tenant_id = $1
       AND NOT EXISTS (SELECT 1 FROM sync_outbox o WHERE o.tenant_id = f.tenant_id AND o.entity_id = f.id)
       AND NOT EXISTS (SELECT 1 FROM sync_inbox  b WHERE b.tenant_id = f.tenant_id AND b.entity_id = f.id)
    UNION ALL
    SELECT 'color', c.id::text FROM colors c
     WHERE c.tenant_id = $1
       AND NOT EXISTS (SELECT 1 FROM sync_outbox o WHERE o.tenant_id = c.tenant_id AND o.entity_id = c.id)
       AND NOT EXISTS (SELECT 1 FROM sync_inbox  b WHERE b.tenant_id = c.tenant_id AND b.entity_id = c.id)`;

  const orphans = await q(A.db, ORPHAN_SQL, [TENANT_ID]);
  check(
    "no locally-originated business row exists without a corresponding outbox operation (0 orphans)",
    orphans.length === 0,
    orphans.length === 0 ? "0 orphans" : `orphans=${JSON.stringify(orphans).slice(0, 400)}`,
  );

  // ------------------------------------------------------------------
  section("6. Restart: durable queue survives a process restart");
  const pendingBefore = await q(
    A.db,
    `SELECT count(*)::int AS c FROM sync_outbox WHERE tenant_id = $1 AND status = 'pending'`,
    [TENANT_ID],
  );
  for (const s of servers.filter((x) => x.__name === "A")) {
    s.kill("SIGKILL");
  }
  await new Promise((r) => setTimeout(r, 1200));
  startServer("A", A.db, A.port, `http://127.0.0.1:${HUB.port}`, "f07-a-restart.log");
  await waitForHealth(A.port, "device A (restart)");
  const pendingAfter = await q(
    A.db,
    `SELECT count(*)::int AS c FROM sync_outbox WHERE tenant_id = $1 AND status = 'pending'`,
    [TENANT_ID],
  );
  check(
    "the pending outbox units survived the restart",
    Number(pendingBefore[0].c) > 0 && pendingAfter[0].c === pendingBefore[0].c,
    `pending before=${pendingBefore[0].c} after=${pendingAfter[0].c}`,
  );

  // ------------------------------------------------------------------
  section("7. Reconnect / sync: queued units reach the hub");
  const runA = await api(A.port, "POST", "/api/sync/run", { deviceId: DEV_A });
  check("device A sync/run succeeded", runA.status === 200, `HTTP ${runA.status} ${JSON.stringify(runA.json)?.slice(0, 200)}`);
  await syncUntilDrained(A.port, DEV_A);

  const hubParties = await q(
    HUB.db,
    `SELECT name FROM parties WHERE tenant_id = $1 ORDER BY name`,
    [TENANT_ID],
  );
  const hubNames = hubParties.map((r) => r.name);
  check(
    "the previously-queued customer reached the hub",
    hubNames.includes("F07-Customer-1") && hubNames.includes("F07-Recovered"),
    `hub parties = ${hubNames.join(", ")}`,
  );
  check(
    "the rollback victim never reached the hub (it was never stored)",
    !hubNames.includes("F07-Must-Rollback"),
    `hub parties = ${hubNames.join(", ")}`,
  );

  const hubInvoices = await q(
    HUB.db,
    `SELECT number, total FROM invoices WHERE tenant_id = $1 ORDER BY number`,
    [TENANT_ID],
  );
  check(
    "the sale invoice reached the hub",
    hubInvoices.length >= 1,
    `hub invoices = ${JSON.stringify(hubInvoices)}`,
  );

  // ------------------------------------------------------------------
  section("8. Device A/B convergence (no lost operation)");
  // Device B writes its own customer while offline, then both nodes sync until
  // the queues drain. A/B ordering is arrival-based (FWW), so both directions
  // need a round: A pushes+pulls, then B pushes+pulls, then A pulls again.
  await mkCustomer(B.port, DEV_B, "F07-B-Customer");
  await syncUntilDrained(A.port, DEV_A);
  await syncUntilDrained(B.port, DEV_B);
  await syncUntilDrained(A.port, DEV_A);
  const runB = await api(B.port, "GET", "/api/sync/status", { deviceId: DEV_B });
  check("device B sync endpoints reachable", runB.status === 200, `HTTP ${runB.status}`);

  const aParties = (await q(A.db, `SELECT name FROM parties WHERE tenant_id = $1 ORDER BY name`, [TENANT_ID])).map((r) => r.name);
  const bParties = (await q(B.db, `SELECT name FROM parties WHERE tenant_id = $1 ORDER BY name`, [TENANT_ID])).map((r) => r.name);
  const hubAll = (await q(HUB.db, `SELECT name FROM parties WHERE tenant_id = $1 ORDER BY name`, [TENANT_ID])).map((r) => r.name);

  check(
    "device A converged to include device B's customer",
    aParties.includes("F07-B-Customer"),
    `A = ${aParties.join(", ")}`,
  );
  check(
    "device B converged to include device A's customers",
    bParties.includes("F07-Customer-1") && bParties.includes("F07-Recovered"),
    `B = ${bParties.join(", ")}`,
  );
  check(
    "all three nodes agree on the same party set (no divergence)",
    JSON.stringify(aParties) === JSON.stringify(hubAll) && JSON.stringify(bParties) === JSON.stringify(hubAll),
    `A=${aParties.length} B=${bParties.length} hub=${hubAll.length}`,
  );

  const finalOrphans = await q(A.db, ORPHAN_SQL, [TENANT_ID]);
  check(
    "AFTER CONVERGENCE: still 0 locally-originated rows without an outbox unit",
    finalOrphans.length === 0,
    finalOrphans.length === 0 ? "0 orphans" : `orphans=${JSON.stringify(finalOrphans).slice(0, 300)}`,
  );

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
  for (const f of ["f07-hub.log", "f07-a.log", "f07-b.log", "f07-a-restart.log"]) {
    const p = path.join(BACKEND, f);
    if (fs.existsSync(p)) console.error(`\n----- ${f} -----\n${fs.readFileSync(p, "utf8").slice(-3000)}`);
  }
} finally {
  await stopAllServers();
}
process.exit(exitCode);
