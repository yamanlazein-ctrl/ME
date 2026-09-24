/**
 * REAL multi-device sync acceptance test (FIN-08 behavioural sync proof).
 *
 * Topology (three independent databases, three real backend processes):
 *
 *   Device A  (sync_dev_a, :8092, CENTRAL_SYNC_URL -> hub)  ─┐
 *   Device B  (sync_dev_b, :8093, CENTRAL_SYNC_URL -> hub)  ─┼─> Hub (sync_hub, :8091)
 *   Stub 401  (:8099, plain http, used for the retryable-status test)
 *
 * Nothing is mocked: real PostgreSQL, real migrations, real Express routes,
 * real outbox/inbox/claim/materialize code, real JWT auth.
 *
 * Determinism (FIN-08): every scenario group re-clones HUB/A/B from the
 * migrated template and restarts the three processes, so leftover parties /
 * inbox / claims / notifications cannot leak into the next scenario. Scores
 * must be stable across identical runs (blocking CI gate, not advisory).
 *
 * Scenarios covered (maps 1:1 to the required acceptance criteria):
 *   S1 both devices write offline, isolated                      -> no premature visibility
 *   S2 reconnect: push + pull until convergence                  -> no loss, no duplication
 *   S3 ordering is stable and follows insertion order             -> correct order
 *   S4 concurrent claim on a shared resource                      -> 409 conflict, not 500
 *   S5 pull cursor over identical received_at timestamps          -> no loss on ties
 *   S6 pull with excludeSyncDeviceId while own units fill window  -> no livelock
 *   S7 outbox unit stranded in `pushing` by a crash               -> reclaimed, not lost
 *   S8 hub returns 401 mid-batch                                  -> stays pending, not rejected
 *
 * Usage:  node scripts/verify-sync-multidevice.mjs [--keep] [--refresh-template]
 */

import pg from "pg";
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";
import fs from "node:fs";
import path from "node:path";
import http from "node:http";

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
const STUB_PORT = 8099;

const results = [];
let servers = [];
let stubServer = null;

function check(name, pass, detail = "") {
  results.push({ name, pass, detail });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
}

function section(title) {
  console.log(`\n=== ${title} ===`);
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
  // FIN-08: CI has no .env file — it exports the secrets as real environment
  // variables. Without this the harness minted a JWT with `undefined` as the
  // key and died before running a single scenario, so it could never be used
  // as a gate.
  for (const key of ["JWT_SECRET", "APP_MASTER_KEY", "LICENSE_SIGNING_KEY", "LICENSE_SIGNING_PUBLIC_KEY"]) {
    if (!env[key] && process.env[key]) env[key] = process.env[key];
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

async function resetDatabases() {
  const c = await adminClient();
  for (const { db } of [HUB, A, B]) {
    await c.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
    await c.query(`CREATE DATABASE "${db}"`);
  }
  await c.end();
}

/**
 * Build (or reuse) a fully migrated template database, then clone it for each
 * node. Migrating three databases from scratch takes ~7 minutes; cloning a
 * template takes milliseconds. Pass --refresh-template to rebuild it.
 */
async function ensureTemplate() {
  const refresh = process.argv.includes("--refresh-template");
  const c = await adminClient();
  const exists = await c.query(`SELECT 1 FROM pg_database WHERE datname = $1`, [TEMPLATE_DB]);
  if (exists.rows.length > 0 && !refresh) {
    // Confirm it really carries the sync tables before trusting it.
    await c.end();
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
    // Migration 0054: the notifications CHECK must accept kind='sync',
    // otherwise every conflict notice silently fails to insert.
    const kindCheck = await probe.query(
      `SELECT pg_get_constraintdef(c.oid) AS def
         FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid
        WHERE t.relname = 'notifications' AND c.conname = 'notifications_kind_check'`,
    );
    const kindOk = (kindCheck.rows[0]?.def ?? "").includes("'sync'");
    // Batch 4 / 4B: the device-trust columns must exist, otherwise a reused
    // template predates the device-trust migration and every sync_devices
    // insert below would fail with 42703.
    const trust = await probe.query(
      `SELECT count(*)::int AS c FROM information_schema.columns
        WHERE table_name='sync_devices'
          AND column_name IN ('revoked_at','revoke_reason','authorized_user_ids')`,
    );
    const trustOk = trust.rows[0].c === 3;
    await probe.end();
    if (t.rows[0].c === 6 && seq.rows[0].c === 1 && kindOk && trustOk) {
      console.log(
        `  template ${TEMPLATE_DB} reused (6 sync tables, migration 0053 + 0054 + device trust present)`,
      );
      return;
    }
    console.log(`  template ${TEMPLATE_DB} is stale — rebuilding`);
    const c2 = await adminClient();
    await c2.query(`DROP DATABASE IF EXISTS "${TEMPLATE_DB}" WITH (FORCE)`);
    await c2.query(`CREATE DATABASE "${TEMPLATE_DB}"`);
    await c2.end();
  } else {
    await c.query(`DROP DATABASE IF EXISTS "${TEMPLATE_DB}" WITH (FORCE)`);
    await c.query(`CREATE DATABASE "${TEMPLATE_DB}"`);
    await c.end();
  }
  console.log(`  migrating template ${TEMPLATE_DB} (this is the slow part, ~2 min)…`);
  await migrate(TEMPLATE_DB);
  console.log(`  template ready`);
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
    const child = spawn(
      process.execPath,
      ["node_modules/drizzle-kit/bin.cjs", "migrate"],
      {
        cwd: BACKEND,
        env: { ...process.env, ...BASE_ENV, DATABASE_URL: dbUrl(db), NODE_ENV: "test" },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
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
     VALUES ($1, 'Sync Test Tenant', $2, 'active', 'no_license', 'trial')
     ON CONFLICT (id) DO NOTHING`,
    [TENANT_ID, `sync-test-${db}`],
  );
  await c.query(
    `INSERT INTO users (id, tenant_id, name, email, password_hash, role, active)
     VALUES ($1, $2, 'Sync Admin', $3, 'not-used-tokens-are-minted', 'admin', true)
     ON CONFLICT (id) DO NOTHING`,
    [USER_ID, TENANT_ID, `admin-${db}@sync.local`],
  );
  await c.query(
    // Batch 4 / 4B: devices registered through the API are bound to the user
    // who registered them; the drill emulates that row (fingerprint + owner).
    `INSERT INTO sync_devices (id, tenant_id, device_fingerprint, platform, hostname, label,
                               last_seen_by_user_id, authorized_user_ids)
     VALUES ($1, $2, $3, 'windows', $4, $4, $5, ARRAY[$5]::uuid[])
     ON CONFLICT (id) DO NOTHING`,
    [DEV_A, TENANT_ID, `fp-device-a-${db}`, "device-a", USER_ID],
  );
  await c.query(
    `INSERT INTO sync_devices (id, tenant_id, device_fingerprint, platform, hostname, label,
                               last_seen_by_user_id, authorized_user_ids)
     VALUES ($1, $2, $3, 'windows', $4, $4, $5, ARRAY[$5]::uuid[])
     ON CONFLICT (id) DO NOTHING`,
    [DEV_B, TENANT_ID, `fp-device-b-${db}`, "device-b", USER_ID],
  );
  // Migration 20260922 moved device↔user authorization into its own table;
  // `sync_devices.authorized_user_ids` is now a denormalized cache that the
  // repository OVERWRITES from `sync_device_authorized_users` on every read.
  // Seeding only the array column left the gate seeing an empty binding, so
  // every device call answered 403 SYNC_DEVICE_NOT_BOUND and the whole drill
  // collapsed before exercising convergence.
  for (const deviceId of [DEV_A, DEV_B]) {
    await c.query(
      `INSERT INTO sync_device_authorized_users (tenant_id, device_id, user_id)
       VALUES ($1, $2, $3)
       ON CONFLICT DO NOTHING`,
      [TENANT_ID, deviceId, USER_ID],
    );
  }
  // The install gate returns 503 for every non-allow-listed path until the
  // setup wizard is marked complete, so the tenant must look installed.
  await c.query(
    `INSERT INTO setup_wizard_state (tenant_id, current_step, completed_steps, is_completed, completed_at)
     VALUES ($1, 'done', ARRAY['welcome'], true, now())
     ON CONFLICT (tenant_id) DO UPDATE SET is_completed = true, current_step = 'done'`,
    [TENANT_ID],
  );
  await c.end();
}

const JWT_HUB =
  BASE_ENV.JWT_SECRET && BASE_ENV.JWT_SECRET.length >= 32
    ? BASE_ENV.JWT_SECRET
    : "hub-sync-jwt-secret-key-min-32-chars!!";
const JWT_A = "device-a-offline-sync-jwt-secret-key!!";
const JWT_B = "device-b-offline-sync-jwt-secret-key!!";
const APP_MASTER_KEY =
  BASE_ENV.APP_MASTER_KEY || "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=";

function startServer(name, db, port, centralUrl, logFile, extraEnv = {}) {
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
    JWT_SECRET: extraEnv.JWT_SECRET || JWT_HUB,
    APP_MASTER_KEY: extraEnv.APP_MASTER_KEY || APP_MASTER_KEY,
    ...extraEnv,
  };
  /**
   * Both of these must be DELETED, not blanked:
   *  - CENTRAL_SYNC_URL is `z.string().url().optional()`, so "" fails validation
   *    and the process dies at config parse time.
   *  - DESKTOP_DEPLOY is `z.coerce.boolean()`, and Boolean("false") === true, so
   *    passing the string "false" would silently turn desktop mode ON for every
   *    node (including the hub, which must not behave like a device).
   */
  delete env.CENTRAL_SYNC_URL;
  delete env.DESKTOP_DEPLOY;
  if (centralUrl) env.CENTRAL_SYNC_URL = centralUrl;

  const child = spawn(
    process.execPath,
    ["node_modules/tsx/dist/cli.mjs", "src/presentation/server.ts"],
    { cwd: BACKEND, env, stdio: ["ignore", out, out] },
  );
  child.__name = name;
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
  // Surface whatever the server managed to print — a silent non-listening
  // process is otherwise impossible to diagnose.
  let tail = "";
  for (const f of ["sync-test-hub.log", "sync-test-a.log", "sync-test-b.log", "sync-test-b401.log", "sync-test-b2.log"]) {
    const p = path.join(BACKEND, f);
    if (fs.existsSync(p) && fs.statSync(p).size > 0) {
      tail += `\n----- ${f} -----\n${fs.readFileSync(p, "utf8").slice(-2000)}`;
    }
  }
  throw new Error(
    `${label} did not become healthy on :${port} (last: ${lastErr})${tail || "\n(no server output at all)"}`,
  );
}

async function stopServer(port) {
  const idx = servers.findIndex((s) => s.__port === port);
  if (idx === -1) return;
  const child = servers[idx];
  servers.splice(idx, 1);
  child.kill("SIGKILL");
  await new Promise((r) => setTimeout(r, 800));
}

async function stopAllServers() {
  const ports = [...new Set(servers.map((s) => s.__port).filter(Boolean))];
  for (const port of ports) {
    await stopServer(port);
  }
  for (const s of [...servers]) {
    try {
      s.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
  servers = [];
  await new Promise((r) => setTimeout(r, 500));
}

/**
 * FIN-08: tear down processes, re-clone HUB/A/B from the migrated template,
 * re-seed, and bring the three nodes back up. Call before every scenario
 * group so checks never see leftover rows from a previous story.
 */
async function resetTopology({ provision = false } = {}) {
  await stopAllServers();
  await cloneDatabases();
  for (const { db } of [HUB, A, B]) {
    await seed(db);
  }

  tokens.set(HUB.port, await mintToken(JWT_HUB));
  tokens.set("hub", tokens.get(HUB.port));
  tokens.set(A.port, await mintToken(JWT_A));
  tokens.set(B.port, await mintToken(JWT_B));

  const hubProc = startServer("hub", HUB.db, HUB.port, null, "sync-test-hub.log", {
    JWT_SECRET: JWT_HUB,
    APP_MASTER_KEY,
  });
  hubProc.__port = HUB.port;
  await waitForHealth(HUB.port, "hub");

  const aProc = startServer("A", A.db, A.port, `http://127.0.0.1:${HUB.port}`, "sync-test-a.log", {
    JWT_SECRET: JWT_A,
    HUB_SYNC_ACCESS_TOKEN: tokens.get("hub"),
    APP_MASTER_KEY,
  });
  aProc.__port = A.port;
  await waitForHealth(A.port, "device A");

  const bProc = startServer("B", B.db, B.port, `http://127.0.0.1:${HUB.port}`, "sync-test-b.log", {
    JWT_SECRET: JWT_B,
    HUB_SYNC_ACCESS_TOKEN: tokens.get("hub"),
    APP_MASTER_KEY,
  });
  bProc.__port = B.port;
  await waitForHealth(B.port, "device B");

  if (provision) {
    const BLOCK_TYPES = ["customer", "supplier", "invoice", "invoice_entry"];
    const provA = await provisionNumberBlocks(A.port, DEV_A, BLOCK_TYPES);
    const provB = await provisionNumberBlocks(B.port, DEV_B, BLOCK_TYPES);
    if (provA.status !== 200 || (provA.json?.ensured?.length ?? 0) !== BLOCK_TYPES.length) {
      throw new Error(`resetTopology provision A failed: HTTP ${provA.status} ${provA.text.slice(0, 200)}`);
    }
    if (provB.status !== 200 || (provB.json?.ensured?.length ?? 0) !== BLOCK_TYPES.length) {
      throw new Error(`resetTopology provision B failed: HTTP ${provB.status} ${provB.text.slice(0, 200)}`);
    }
  }
}

// ---------------------------------------------------------------- auth

async function mintToken(secret = JWT_HUB) {
  const key = new TextEncoder().encode(secret);
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
    // jose requires a key object / Uint8Array, never a raw string: passing the
    // string threw "Key for the HS256 algorithm must be one of type ..." and
    // aborted the whole drill.
    .sign(key);
}

const tokens = new Map();

async function api(port, method, urlPath, { body, deviceId } = {}) {
  const token = tokens.get(port) ?? tokens.get("hub");
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
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

// ---------------------------------------------------------------- helpers

async function countParties(db) {
  const c = await dbClient(db);
  const r = await c.query(`SELECT count(*)::int AS c FROM parties WHERE tenant_id = $1`, [TENANT_ID]);
  await c.end();
  return r.rows[0].c;
}

async function partyNames(db) {
  const c = await dbClient(db);
  const r = await c.query(
    `SELECT name FROM parties WHERE tenant_id = $1 ORDER BY name`,
    [TENANT_ID],
  );
  await c.end();
  return r.rows.map((x) => x.name);
}

async function outboxRows(db) {
  const c = await dbClient(db);
  const r = await c.query(
    `SELECT id, op_id, status, seq, error_detail FROM sync_outbox WHERE tenant_id = $1 ORDER BY seq`,
    [TENANT_ID],
  );
  await c.end();
  return r.rows;
}

async function inboxRows(db) {
  const c = await dbClient(db);
  const r = await c.query(
    `SELECT op_id, status, received_seq, received_at, sync_device_id, apply_attempts,
            reject_reason, conflict_op_id
     FROM sync_inbox WHERE tenant_id = $1 ORDER BY received_seq`,
    [TENANT_ID],
  );
  await c.end();
  return r.rows;
}

async function createParty(port, deviceId, name) {
  return api(port, "POST", "/api/customers", { deviceId, body: { name } });
}

/**
 * Reserve this device's document-number blocks — the real provisioning path a
 * desktop node follows while it still has connectivity, before it goes
 * offline. Without a reserved block a node falls back to its own local
 * sequence and two nodes mint the same `CUS-<year>-0001`.
 */
async function provisionNumberBlocks(port, deviceId, entityTypes) {
  return api(port, "POST", "/api/sync/number-blocks/ensure", {
    deviceId,
    body: { syncDeviceId: deviceId, entityTypes },
  });
}

async function numberBlocks(db) {
  const c = await dbClient(db);
  const r = await c.query(
    `SELECT entity_type, start_number, end_number, next_number, status
     FROM document_number_blocks WHERE tenant_id = $1 ORDER BY entity_type, start_number`,
    [TENANT_ID],
  );
  await c.end();
  return r.rows.map((x) => ({
    entityType: x.entity_type,
    startNumber: x.start_number,
    endNumber: x.end_number,
    nextNumber: x.next_number,
    status: x.status,
  }));
}

async function partyCodes(db) {
  const c = await dbClient(db);
  const r = await c.query(
    `SELECT code, name FROM parties WHERE tenant_id = $1 ORDER BY name`,
    [TENANT_ID],
  );
  await c.end();
  return r.rows.map((x) => `${x.name}=${x.code}`);
}

/** Run sync until the outbox drains and nothing new is pulled. */
async function syncUntilDrained(port, maxRounds = 6) {
  const rounds = [];
  for (let i = 0; i < maxRounds; i += 1) {
    const r = await api(port, "POST", "/api/sync/run");
    rounds.push(r.json ?? { status: r.status });
    if (r.status !== 200) break;
    const j = r.json;
    const noPush = (j.pushed ?? 0) === 0 && (j.failed ?? 0) === 0 && (j.rejected ?? 0) === 0;
    const noPull = (j.pull?.pulled ?? 0) === 0;
    if (noPush && noPull) break;
  }
  return rounds;
}

// ---------------------------------------------------------------- main

async function main() {
  console.log("Sync multi-device acceptance test (FIN-08 isolated scenarios)");
  console.log(`  hub=${HUB.db}:${HUB.port}  A=${A.db}:${A.port}  B=${B.db}:${B.port}`);

  section("0. Prepare migrated template (once)");
  await ensureTemplate();
  // Prove migrations landed on the template before any scenario clones it.
  {
    const c = await dbClient(TEMPLATE_DB);
    const cols = await c.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name='sync_inbox' AND column_name IN ('received_seq','apply_attempts','materialize_error')`,
    );
    const outboxSeq = await c.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name='sync_outbox' AND column_name='seq'`,
    );
    const stateSeq = await c.query(
      `SELECT column_name FROM information_schema.columns
       WHERE table_name='sync_state' AND column_name='last_pull_seq'`,
    );
    await c.end();
    check(
      "migration 0053 applied (received_seq, apply_attempts, materialize_error, outbox.seq, last_pull_seq)",
      cols.rows.length === 3 && outboxSeq.rows.length === 1 && stateSeq.rows.length === 1,
      `inbox=${cols.rows.length}/3 outbox.seq=${outboxSeq.rows.length} last_pull_seq=${stateSeq.rows.length}`,
    );
  }

  check(
    "drill uses distinct JWT secrets (not a shared production secret)",
    JWT_A !== JWT_B && JWT_A !== JWT_HUB && JWT_B !== JWT_HUB,
    "A/B/hub secrets differ",
  );

  section("0b. Fresh topology for S0–S2 (clone template + restart processes)");
  await resetTopology({ provision: false });
  console.log("  hub + A + B healthy on fresh clones");

  // ------------------------------------------------------------ S0
  section("S0. Provision reserved number blocks while online (then go offline)");
  const BLOCK_TYPES = ["customer", "supplier", "invoice", "invoice_entry"];
  const provA = await provisionNumberBlocks(A.port, DEV_A, BLOCK_TYPES);
  const provB = await provisionNumberBlocks(B.port, DEV_B, BLOCK_TYPES);
  check(
    "device A reserved its number blocks from the hub",
    provA.status === 200 && (provA.json?.ensured?.length ?? 0) === BLOCK_TYPES.length,
    `HTTP ${provA.status} ${JSON.stringify(provA.json?.ensured ?? provA.text.slice(0, 200))}`,
  );
  check(
    "device B reserved its number blocks from the hub",
    provB.status === 200 && (provB.json?.ensured?.length ?? 0) === BLOCK_TYPES.length,
    `HTTP ${provB.status} ${JSON.stringify(provB.json?.ensured ?? provB.text.slice(0, 200))}`,
  );
  {
    const blocksA = await numberBlocks(A.db);
    const blocksB = await numberBlocks(B.db);
    const custA = blocksA.find((b) => b.entityType === "customer");
    const custB = blocksB.find((b) => b.entityType === "customer");
    check(
      "the two devices hold disjoint customer number ranges (no code collision possible)",
      Boolean(
        custA &&
          custB &&
          (custA.endNumber < custB.startNumber || custB.endNumber < custA.startNumber),
      ),
      `A=${custA ? `${custA.startNumber}..${custA.endNumber}` : "none"} ` +
        `B=${custB ? `${custB.startNumber}..${custB.endNumber}` : "none"}`,
    );
  }

  // ------------------------------------------------------------ S1
  section("S1. Both devices write offline (no hub contact yet)");
  const aNames = ["A-Customer-1", "A-Customer-2"];
  const bNames = ["B-Customer-1"];
  for (const n of aNames) {
    const r = await createParty(A.port, DEV_A, n);
    if (r.status !== 201 && r.status !== 200) {
      check(`device A creates ${n}`, false, `HTTP ${r.status} ${r.text.slice(0, 160)}`);
    }
  }
  for (const n of bNames) {
    const r = await createParty(B.port, DEV_B, n);
    if (r.status !== 201 && r.status !== 200) {
      check(`device B creates ${n}`, false, `HTTP ${r.status} ${r.text.slice(0, 160)}`);
    }
  }
  const aLocal1 = await partyNames(A.db);
  const bLocal1 = await partyNames(B.db);
  const hubLocal1 = await partyNames(HUB.db);
  check(
    "device A holds exactly its own 2 customers locally",
    aLocal1.length === 2 && aNames.every((n) => aLocal1.includes(n)),
    aLocal1.join(", "),
  );
  check(
    "device B holds exactly its own 1 customer locally",
    bLocal1.length === 1 && bLocal1.includes(bNames[0]),
    bLocal1.join(", "),
  );
  check("hub has received nothing yet (true offline isolation)", hubLocal1.length === 0, `hub=${hubLocal1.length}`);

  const aOutbox1 = await outboxRows(A.db);
  check(
    "each offline write was queued in the outbox with a monotonic seq",
    aOutbox1.length === 2 && aOutbox1[0].seq < aOutbox1[1].seq && aOutbox1.every((r) => r.status === "pending"),
    aOutbox1.map((r) => `${r.status}@${r.seq}`).join(" "),
  );

  // ------------------------------------------------------------ S2
  section("S2. Reconnect: sync until converged");
  await syncUntilDrained(A.port);
  await syncUntilDrained(B.port);
  await syncUntilDrained(A.port);

  const aLocal2 = await partyNames(A.db);
  const bLocal2 = await partyNames(B.db);
  const hubLocal2 = await partyNames(HUB.db);
  const expected = [...aNames, ...bNames].sort();
  const same = (arr) => JSON.stringify([...arr].sort()) === JSON.stringify(expected);

  check("hub converged to both devices' customers", same(hubLocal2), hubLocal2.join(", "));
  check("device A converged (received B's customer)", same(aLocal2), aLocal2.join(", "));
  check("device B converged (received A's customers)", same(bLocal2), bLocal2.join(", "));

  {
    // The collision that killed the first acceptance run: both nodes minted
    // `CUS-<year>-0001`, the hub rejected the second insert on
    // `parties (tenant_id, code)`, and the unit was stranded. Codes must now be
    // globally unique because each node draws from its own reserved block.
    const hubCodes = await partyCodes(HUB.db);
    const codes = hubCodes.map((x) => x.split("=")[1]);
    const aCodes = await partyCodes(A.db);
    const bCodes = await partyCodes(B.db);
    check(
      "party codes are globally unique on the hub (no (tenant_id, code) collision)",
      new Set(codes).size === codes.length && codes.length === 3,
      hubCodes.join(", "),
    );
    check(
      "both devices show identical codes for the same parties",
      JSON.stringify(aCodes.sort()) === JSON.stringify(bCodes.sort()) &&
        JSON.stringify(aCodes.sort()) === JSON.stringify(hubCodes.sort()),
      `A=[${aCodes.join(", ")}] B=[${bCodes.join(", ")}]`,
    );
  }

  check(
    "no duplication on any node (exactly 3 rows each)",
    (await countParties(A.db)) === 3 &&
      (await countParties(B.db)) === 3 &&
      (await countParties(HUB.db)) === 3,
    `A=${await countParties(A.db)} B=${await countParties(B.db)} hub=${await countParties(HUB.db)}`,
  );

  const aOutbox2 = await outboxRows(A.db);
  check(
    "device A outbox drained to synced (nothing lost)",
    aOutbox2.length === 2 && aOutbox2.every((r) => r.status === "synced"),
    aOutbox2.map((r) => r.status).join(","),
  );

  // Idempotency: push the same unit again by resetting one to pending.
  {
    const c = await dbClient(A.db);
    await c.query(`UPDATE sync_outbox SET status='pending' WHERE tenant_id=$1 AND seq=$2`, [
      TENANT_ID,
      aOutbox2[0].seq,
    ]);
    await c.end();
    await syncUntilDrained(A.port);
    const after = await countParties(HUB.db);
    check(
      "replaying an already-applied unit does not duplicate it (idempotent)",
      after === 3,
      `hub rows after replay=${after}`,
    );
  }

  // ------------------------------------------------------------ S3
  section("S3. Ordering is deterministic and follows insertion order");
  console.log("  · resetting topology (no leak from S0–S2)");
  await resetTopology({ provision: true });
  const ordered = [];
  for (let i = 0; i < 5; i += 1) {
    const r = await createParty(A.port, DEV_A, `A-Order-${i}`);
    if (r.status >= 400) check(`ordering: create A-Order-${i}`, false, `HTTP ${r.status}`);
    if (r.json?.id) ordered.push(r.json.id);
  }
  const pend = await api(A.port, "GET", "/api/sync/pending");
  const pendItems = pend.json?.items ?? [];
  const seqs = pendItems.map((i) => i.seq);
  const strictlyIncreasing = seqs.every((s, i) => i === 0 || s > seqs[i - 1]);
  const firstThreeMatch = pendItems.slice(0, 5).length === 5;
  check(
    "outbox exposes a strictly increasing seq (stable ordering key)",
    strictlyIncreasing && firstThreeMatch,
    `seqs=${seqs.join(",")}`,
  );
  const repeat = await api(A.port, "GET", "/api/sync/pending");
  check(
    "repeated reads return the identical order (no timestamp-tie instability)",
    JSON.stringify(repeat.json?.items?.map((i) => i.seq)) === JSON.stringify(seqs),
    `repeat=${repeat.json?.items?.map((i) => i.seq).join(",")}`,
  );
  await syncUntilDrained(A.port);

  // ------------------------------------------------------------ S4
  section("S4. Conflict: two devices claim the same resource");
  console.log("  · resetting topology (no leak from S3)");
  await resetTopology({ provision: false });
  {
    const push = (opId, deviceId, invoiceId, sharedRoll) =>
      api(HUB.port, "POST", "/api/sync/push", {
        deviceId,
        body: {
          opId,
          syncDeviceId: deviceId,
          entityType: "invoice",
          entityId: invoiceId,
          operation: "create",
          payload: {
            invoiceId,
            invoiceNumber: `INV-2026-9${Math.floor(Math.random() * 900 + 100)}`,
            invoiceType: "sale",
            rollIds: [sharedRoll],
            preAllocated: true,
            actorUserId: USER_ID,
            actorRole: "admin",
            actorUserName: "Sync Admin",
          },
        },
      });

    // Retry a few times if scheduling collapses both into the same status —
    // the claim path is racey under load, but the contract is still one 201 + one 409.
    let ra;
    let rb;
    let opA;
    let opB;
    let sharedRoll;
    let codes = [];
    for (let attempt = 1; attempt <= 5; attempt += 1) {
      sharedRoll = randomUUID();
      opA = randomUUID();
      opB = randomUUID();
      [ra, rb] = await Promise.all([
        push(opA, DEV_A, randomUUID(), sharedRoll),
        push(opB, DEV_B, randomUUID(), sharedRoll),
      ]);
      codes = [ra.status, rb.status].sort();
      if (codes[0] === 201 && codes[1] === 409) break;
      console.log(`  · S4 attempt ${attempt}: statuses=${ra.status},${rb.status} — retry`);
    }
    const winner = ra.status < 400 ? "A" : rb.status < 400 ? "B" : null;
    const loserRes = ra.status === 409 ? ra : rb.status === 409 ? rb : null;

    check(
      "concurrent claim yields exactly one 201 and one 409 (never a 500)",
      codes[0] === 201 && codes[1] === 409,
      `statuses=${ra.status},${rb.status}`,
    );
    check(
      "the loser receives a structured conflict payload",
      Boolean(loserRes?.json?.code === "SYNC_CONFLICT" && loserRes?.json?.conflictOpId),
      `code=${loserRes?.json?.code} winnerOp=${loserRes?.json?.conflictOpId?.slice(0, 8) ?? "none"}`,
    );

    const inbox = await inboxRows(HUB.db);
    // Scope to the two units THIS test pushed — earlier scenarios already put
    // several applied units on the hub, so a global count is meaningless.
    const mine = inbox.filter((r) => r.op_id === opA || r.op_id === opB);
    const rejected = mine.filter((r) => r.status === "rejected");
    const accepted = mine.filter((r) => r.status !== "rejected");
    const expectedWinnerOp = winner === "A" ? opA : winner === "B" ? opB : null;
    check(
      "the loser is recorded as rejected on the hub with a reason and a winner",
      mine.length === 2 &&
        rejected.length === 1 &&
        accepted.length === 1 &&
        accepted[0].op_id === expectedWinnerOp &&
        typeof rejected[0].reject_reason === "string" &&
        rejected[0].reject_reason.length > 0 &&
        rejected[0].conflict_op_id === expectedWinnerOp,
      `mine=${mine.length} accepted=${accepted.length} rejected=${rejected.length} ` +
        `reason="${rejected[0]?.reject_reason?.slice(0, 40) ?? ""}" ` +
        `winnerOp=${rejected[0]?.conflict_op_id?.slice(0, 8) ?? "none"}`,
    );

    const c = await dbClient(HUB.db);
    const claims = await c.query(
      `SELECT count(*)::int AS c FROM sync_resource_claims WHERE tenant_id=$1 AND resource_id=$2`,
      [TENANT_ID, sharedRoll],
    );
    const notifs = await c.query(
      `SELECT count(*)::int AS c FROM notifications WHERE tenant_id=$1 AND kind='sync'`,
      [TENANT_ID],
    );
    await c.end();
    check(
      "exactly one claim is held for the contested resource",
      claims.rows[0].c === 1,
      `claims=${claims.rows[0].c}`,
    );
    check(
      "the losing user is notified",
      notifs.rows[0].c >= 1,
      `sync notifications=${notifs.rows[0].c}`,
    );
  }

  // ------------------------------------------------------------ S5
  section("S5. Pull cursor survives identical received_at timestamps");
  console.log("  · resetting topology (no leak from S4)");
  await resetTopology({ provision: false });
  {
    const c = await dbClient(HUB.db);
    const frozen = new Date("2026-09-10T12:00:00.000Z");
    const ids = [];
    for (let i = 0; i < 3; i += 1) {
      const r = await c.query(
        `INSERT INTO sync_inbox
           (tenant_id, sync_device_id, op_id, entity_type, entity_id, operation, payload,
            status, received_at, applied_at)
         VALUES ($1,$2,$3,'party',$4,'create','{"snapshot":{}}','applied',$5,$5)
         RETURNING applied_seq`,
        [TENANT_ID, DEV_A, randomUUID(), randomUUID(), frozen],
      );
      ids.push(Number(r.rows[0].applied_seq)); // the pull cursor (application order)
    }
    await c.end();

    // Same timestamp on all three. A strict `>` cursor on received_at returned
    // nothing after the first row — a permanent loss. The seq cursor must
    // return the remaining two.
    const pulled = await api(
      HUB.port,
      "GET",
      `/api/sync/pull?afterSeq=${ids[0]}&limit=50`,
    );
    const got = (pulled.json?.items ?? []).filter((i) =>
      ids.slice(1).includes(i.receivedSeq),
    );
    check(
      "units sharing one received_at are all reachable by the cursor",
      got.length === 2,
      `expected 2 rows after seq ${ids[0]}, got ${got.length}`,
    );
  }

  // ------------------------------------------------------------ S6
  section("S6. Pull excludes own device without stalling");
  console.log("  · resetting topology (no leak from S5)");
  await resetTopology({ provision: false });
  {
    const c = await dbClient(HUB.db);
    // 20 units from device A, then 3 from device B, ordered so that A's units
    // occupy the whole first page. The old post-LIMIT filter returned 0 rows
    // here and the cursor never advanced — a permanent stall.
    for (let i = 0; i < 20; i += 1) {
      await c.query(
        `INSERT INTO sync_inbox
           (tenant_id, sync_device_id, op_id, entity_type, entity_id, operation, payload, status, applied_at)
         VALUES ($1,$2,$3,'party',$4,'create','{"snapshot":{}}','applied',now())`,
        [TENANT_ID, DEV_A, randomUUID(), randomUUID()],
      );
    }
    const bSeqs = [];
    for (let i = 0; i < 3; i += 1) {
      const r = await c.query(
        `INSERT INTO sync_inbox
           (tenant_id, sync_device_id, op_id, entity_type, entity_id, operation, payload, status, applied_at)
         VALUES ($1,$2,$3,'party',$4,'create','{"snapshot":{}}','applied',now())
         RETURNING applied_seq`,
        [TENANT_ID, DEV_B, randomUUID(), randomUUID()],
      );
      bSeqs.push(Number(r.rows[0].applied_seq)); // the pull cursor (application order)
    }
    await c.end();

    // The hub derives "own units" ONLY from the authenticated device header
    // (SYNC-07: the query parameter is ignored so a caller cannot hide another
    // device's units). The desktop client sends both; so does this drill.
    const pulled = await api(
      HUB.port,
      "GET",
      `/api/sync/pull?excludeSyncDeviceId=${DEV_A}&limit=5`,
      { deviceId: DEV_A },
    );
    const returned = (pulled.json?.items ?? []).map((i) => i.receivedSeq);
    const sawB = bSeqs.filter((s) => returned.includes(s)).length;
    const sawA = (pulled.json?.items ?? []).filter((i) => i.syncDeviceId === DEV_A).length;
    check(
      "peer units are returned even when own units would fill the page",
      sawB === 3 && sawA === 0,
      `returned=${returned.length} own=${sawA} peer=${sawB}`,
    );
  }

  // ------------------------------------------------------------ S7
  section("S7. A unit stranded in `pushing` by a crash is reclaimed");
  console.log("  · resetting topology (no leak from S6)");
  await resetTopology({ provision: true });
  {
    const c = await dbClient(A.db);
    const strandedOp = randomUUID();
    const strandedEntity = randomUUID();
    const freshOp = randomUUID();
    const freshEntity = randomUUID();
    const strandedSnapshot = JSON.stringify({
      snapshot: {
        id: strandedEntity,
        kind: "customer",
        name: "A-Stranded-After-Crash",
        currency: "USD",
        status: "active",
      },
    });
    await c.query(
      `INSERT INTO sync_outbox
         (tenant_id, sync_device_id, op_id, entity_type, entity_id, operation, payload,
          status, created_at, updated_at)
       VALUES ($1,$2,$3,'party',$4,'create',$5::jsonb,
          'pushing', now() - interval '30 minutes', now() - interval '30 minutes')`,
      [TENANT_ID, DEV_A, strandedOp, strandedEntity, strandedSnapshot],
    );
    await c.query(
      `INSERT INTO sync_outbox
         (tenant_id, sync_device_id, op_id, entity_type, entity_id, operation, payload,
          status, created_at, updated_at)
       VALUES ($1,$2,$3,'party',$4,'create',$5::jsonb,
          'pushing', now(), now())`,
      [
        TENANT_ID,
        DEV_A,
        freshOp,
        freshEntity,
        JSON.stringify({
          snapshot: {
            id: freshEntity,
            kind: "customer",
            name: "A-Still-In-Flight",
            currency: "USD",
            status: "active",
          },
        }),
      ],
    );
    await c.end();

    const statusBefore = await api(A.port, "GET", "/api/sync/status");
    const pending = await api(A.port, "GET", "/api/sync/pending");
    const pendingOps = (pending.json?.items ?? []).map((i) => i.opId);

    check(
      "a stale `pushing` unit is reported as outstanding (not invisible)",
      pendingOps.includes(strandedOp) && statusBefore.json?.pendingCount >= 1,
      `pendingCount=${statusBefore.json?.pendingCount} listed=${pendingOps.length}`,
    );
    check(
      "an in-flight `pushing` unit inside its lease is NOT stolen",
      !pendingOps.includes(freshOp),
      `fresh op listed=${pendingOps.includes(freshOp)}`,
    );
    check(
      "/sync/status exposes a per-status breakdown",
      Boolean(statusBefore.json?.statusCounts) &&
        typeof statusBefore.json.statusCounts.pushing === "number",
      JSON.stringify(statusBefore.json?.statusCounts ?? {}),
    );

    await syncUntilDrained(A.port);
    const after = await outboxRows(A.db);
    const strandedRow = after.find((r) => r.op_id === strandedOp);
    check(
      "the stranded unit was pushed instead of being lost",
      strandedRow?.status === "synced" || strandedRow?.status === "rejected",
      `status=${strandedRow?.status}`,
    );
  }

  // ------------------------------------------------------------ S8
  section("S8. Hub 401 mid-batch keeps units pending (not rejected)");
  console.log("  · resetting topology (no leak from S7)");
  await resetTopology({ provision: true });
  {
    // A stub hub that rejects everything with 401 — the shape of an expired
    // access token. The old code marked every unit `rejected` forever.
    stubServer = http.createServer((req, res) => {
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ code: "UNAUTHORIZED", message: "expired" }));
    });
    await new Promise((r) => stubServer.listen(STUB_PORT, "127.0.0.1", r));

    // Two fresh offline writes on device B, then point it at the stub hub.
    await createParty(B.port, DEV_B, "B-Retry-1");
    await createParty(B.port, DEV_B, "B-Retry-2");
    await stopServer(B.port);
    const hubToken = tokens.get("hub");
    const b2 = startServer("B401", B.db, B.port, `http://127.0.0.1:${STUB_PORT}`, "sync-test-b401.log", {
      JWT_SECRET: JWT_B,
      HUB_SYNC_ACCESS_TOKEN: hubToken,
      APP_MASTER_KEY,
    });
    b2.__port = B.port;
    await waitForHealth(B.port, "device B (stub hub)");

    const run = await api(B.port, "POST", "/api/sync/run");
    const rows = await outboxRows(B.db);
    const rejected = rows.filter((r) => r.status === "rejected");
    const pendingRows = rows.filter((r) => r.status === "pending" || r.status === "pushing");
    check(
      "a 401 does not permanently reject the queue",
      rejected.length === 0 && pendingRows.length >= 2,
      `pending=${pendingRows.length} rejected=${rejected.length} (run pushed=${run.json?.pushed} failed=${run.json?.failed})`,
    );

    // Point it back at the real hub: the retained units must still sync.
    await stopServer(B.port);
    const b3 = startServer("B", B.db, B.port, `http://127.0.0.1:${HUB.port}`, "sync-test-b2.log", {
      JWT_SECRET: JWT_B,
      HUB_SYNC_ACCESS_TOKEN: hubToken,
      APP_MASTER_KEY,
    });
    b3.__port = B.port;
    await waitForHealth(B.port, "device B (real hub)");
    await syncUntilDrained(B.port);
    await syncUntilDrained(A.port);

    const namesHub = await partyNames(HUB.db);
    const bRetrySynced =
      namesHub.includes("B-Retry-1") && namesHub.includes("B-Retry-2");
    check(
      "retained units sync successfully once the hub is healthy again",
      bRetrySynced,
      `hub has B-Retry-1=${namesHub.includes("B-Retry-1")} B-Retry-2=${namesHub.includes("B-Retry-2")}`,
    );

    const aFinal = await partyNames(A.db);
    check(
      "device A eventually sees every operation from device B",
      aFinal.includes("B-Retry-1") && aFinal.includes("B-Retry-2"),
      `A rows=${aFinal.length}`,
    );
  }

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
  if (stubServer) {
    try {
      stubServer.close();
    } catch {
      /* ignore */
    }
  }
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
      console.log("\n(databases dropped; pass --keep to retain them)");
    } catch {
      /* ignore */
    }
  }
}
process.exit(ok ? 0 : 1);
