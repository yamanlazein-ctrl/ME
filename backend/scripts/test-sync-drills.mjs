/**
 * Sync failure-mode drills (D1–D4).
 *
 * Real PostgreSQL databases cloned from the migrated `sync_tpl` template and
 * real backend processes (SIGKILLed and restarted) — no mocks anywhere.
 *
 *  D1. Device killed mid-push: `pushing` units recover via lease expiry and
 *      converge exactly once (idempotent replay under retry).
 *  D2. Hub killed mid-drain: restart on the same DB, drain completes, no dupes.
 *  D3. Restore-equivalence: a TEMPLATE-cloned copy of the hub serves as the
 *      hub (read + write), proving restore-equivalence at the PG level.
 *  D4. Partition: hub unreachable → drain fails VISIBLY (failed/pullError,
 *      backlog intact); hub back → converges with no loss.
 *
 * Lease note (D1): the pushing lease is 5 minutes of wall-clock. Waiting it
 * out would stall the suite, so the drill backdates `pushing.updated_at` by
 * 6 minutes with an UPDATE that is clearly labeled in the log — the lease
 * check itself reads wall-clock and is not mocked.
 *
 * Usage: node scripts/test-sync-drills.mjs [--keep]
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

const HUB = { db: "drill_hub", port: 8094 };
const A = { db: "drill_dev_a", port: 8095 };
const HUB2 = { db: "drill_restored", port: 8096 };
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
const dbUrl = (db) => `postgresql://${PG.user}:***@${PG.host}:${PG.port}/${db}`;

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
async function q(db, sql, params = []) {
  const c = await dbClient(db);
  try {
    const r = await c.query(sql, params);
    return r.rows;
  } finally {
    await c.end();
  }
}

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

function startServer(name, db, port, centralUrl, logFile) {
  const out = fs.openSync(path.join(BACKEND, logFile), "w");
  const env = {
    ...process.env,
    ...BASE_ENV,
    DATABASE_URL: dbUrl(db),
    PORT: String(port),
    HOST: "127.0.0.1",
    NODE_ENV: "test",
    LOG_LEVEL: "warn",
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
  servers.push(child);
  return child;
}

async function waitForHealth(port, label, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/api/health/live`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) return true;
    } catch {
      /* retry */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`${label} not healthy on :${port}`);
}

function killServer(child) {
  try {
    child.kill("SIGKILL");
  } catch {
    /* ignore */
  }
  const i = servers.indexOf(child);
  if (i >= 0) servers.splice(i, 1);
}

async function syncUntilDrained(port, deviceId, maxRounds = 10) {
  const rounds = [];
  for (let i = 0; i < maxRounds; i += 1) {
    let r;
    try {
      r = await api(port, "POST", "/api/sync/run", { deviceId });
    } catch (e) {
      rounds.push({ fetchError: String(e).slice(0, 80) });
      break;
    }
    rounds.push(r.json ?? { status: r.status });
    if (r.status !== 200) break;
    const j = r.json;
    const noPush = (j.pushed ?? 0) === 0 && (j.failed ?? 0) === 0 && (j.rejected ?? 0) === 0;
    const noPull = (j.pull?.pulled ?? 0) === 0;
    if (noPush && noPull) break;
  }
  return rounds;
}

async function mkStock(port, deviceId, kg = 5000, pieces = 5) {
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
        pricePerKg: 500,
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

async function main() {
  console.log("Sync failure-mode drills (D1-D4)\n");

  section("0. Clone + seed + boot");
  {
    const c = await adminClient();
    for (const { db } of [HUB, A]) {
      await c.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
      await c.query(`CREATE DATABASE "${db}" TEMPLATE "${TEMPLATE_DB}"`);
    }
    await c.end();
    for (const db of [HUB.db, A.db]) {
      const d = await dbClient(db);
      await d.query(
        `INSERT INTO tenants (id, name, slug, status, license_status, license_type)
         VALUES ($1, 'Drill Tenant', $2, 'active', 'no_license', 'trial') ON CONFLICT (id) DO NOTHING`,
        [TENANT_ID, `drill-${db}`],
      );
      await d.query(
        `INSERT INTO users (id, tenant_id, name, email, password_hash, role, active)
         VALUES ($1, $2, 'Drill Admin', $3, 'not-used', 'admin', true) ON CONFLICT (id) DO NOTHING`,
        [USER_ID, TENANT_ID, `admin-${db}@drill.local`],
      );
      await d.query(
        // Batch 4 / 4B: a device row created by the API is always bound to
        // the user who registered it; the drill emulates exactly that row, so
        // it must carry the binding the sync device gate now requires.
        `INSERT INTO sync_devices (id, tenant_id, device_fingerprint, platform, hostname, label,
                                   last_seen_by_user_id, authorized_user_ids)
         VALUES ($1, $2, $3, 'windows', $4, $4, $5, ARRAY[$5]::uuid[])
         ON CONFLICT (id) DO NOTHING`,
        [DEV_A, TENANT_ID, `fp-device-a-${db}`, "device-a", USER_ID],
      );
      await d.query(
        `INSERT INTO setup_wizard_state (tenant_id, current_step, completed_steps, is_completed, completed_at)
         VALUES ($1, 'done', ARRAY['welcome'], true, now())
         ON CONFLICT (tenant_id) DO UPDATE SET is_completed = true, current_step = 'done'`,
        [TENANT_ID],
      );
      await d.end();
    }
  }
  let hub = startServer("hub", HUB.db, HUB.port, null, "drill-hub.log");
  await waitForHealth(HUB.port, "hub");
  let devA = startServer("A", A.db, A.port, `http://127.0.0.1:${HUB.port}`, "drill-a.log");
  await waitForHealth(A.port, "device A");
  TOKEN = await mintToken();
  console.log("  hub + device A healthy");

  // ---- D1: device killed mid-push ----
  section("D1. Device SIGKILLed mid-push recovers via lease (exactly-once)");
  {
    // 30 sales on a 30-piece roll: the point is crash recovery, not
    // contention, so every sale must be able to win (a pieces-short roll
    // would 409 losers and confound the exactly-once assertion).
    const stock = await mkStock(A.port, DEV_A, 5000, 30);
    const cust = await mkCustomer(A.port, DEV_A, "Drill-D1");
    await syncUntilDrained(A.port, DEV_A);
    const N = 30;
    const ids = [];
    for (let i = 0; i < N; i++) {
      const s = await mkSale(A.port, DEV_A, cust.id, {
        fabricId: stock.fab.id,
        colorId: stock.col.id,
        rollId: stock.roll.id,
        quantityKg: 5,
        pricePerKg: 1000,
      });
      ids.push(s.json.id);
    }
    // Fire a drain without awaiting, then SIGKILL mid-flight.
    const drainP = api(A.port, "POST", "/api/sync/run", { deviceId: DEV_A });
    await new Promise((r) => setTimeout(r, 600));
    killServer(devA);
    await drainP.catch(() => null);
    await new Promise((r) => setTimeout(r, 500));
    let pushing = await q(
      A.db,
      `SELECT count(*)::int AS c FROM sync_outbox WHERE tenant_id=$1 AND status='pushing'`,
      [TENANT_ID],
    );
    if (pushing[0]?.c === 0) {
      // Drain finished before the kill — restart first, then retry once with
      // a bigger batch on FRESH stock (the first batch may have partially
      // applied, consuming pieces — reusing its roll would 409 losers and
      // confound the exactly-once assertion).
      devA = startServer("A", A.db, A.port, `http://127.0.0.1:${HUB.port}`, "drill-a.log");
      await waitForHealth(A.port, "device A");
      const stock2 = await mkStock(A.port, DEV_A, 5000, 30);
      const cust2 = await mkCustomer(A.port, DEV_A, "Drill-D1b");
      for (let i = 0; i < 30; i++) {
        const s = await mkSale(A.port, DEV_A, cust2.id, {
          fabricId: stock2.fab.id,
          colorId: stock2.col.id,
          rollId: stock2.roll.id,
          quantityKg: 5,
          pricePerKg: 1000,
        }).catch(() => null);
        if (s?.json?.id) ids.push(s.json.id);
      }
      const drainP2 = api(A.port, "POST", "/api/sync/run", { deviceId: DEV_A });
      await new Promise((r) => setTimeout(r, 500));
      killServer(devA);
      await drainP2.catch(() => null);
      await new Promise((r) => setTimeout(r, 500));
      pushing = await q(
        A.db,
        `SELECT count(*)::int AS c FROM sync_outbox WHERE tenant_id=$1 AND status='pushing'`,
        [TENANT_ID],
      );
    }
    check(
      "kill landed mid-push (units stranded in `pushing`)",
      pushing[0]?.c > 0,
      `pushing=${pushing[0]?.c}`,
    );
    // Labeled time-simulation: the lease reads wall-clock; backdating is
    // equivalent to waiting 6 minutes and keeps the suite fast.
    console.log("  (simulating 6 minutes passing for the 5-minute pushing lease)");
    await q(
      A.db,
      `UPDATE sync_outbox SET updated_at = now() - interval '6 minutes' WHERE tenant_id=$1 AND status='pushing'`,
      [TENANT_ID],
    );
    devA = startServer("A", A.db, A.port, `http://127.0.0.1:${HUB.port}`, "drill-a.log");
    await waitForHealth(A.port, "device A (restarted)");
    await syncUntilDrained(A.port, DEV_A);
    const hubCount = await q(
      HUB.db,
      `SELECT count(*)::int AS c FROM invoices WHERE tenant_id=$1 AND id = ANY($2)`,
      [TENANT_ID, ids],
    );
    const hubDupes = await q(
      HUB.db,
      `SELECT count(*)::int AS c FROM (SELECT id, count(*) FROM invoices WHERE tenant_id=$1 AND id = ANY($2) GROUP BY id HAVING count(*) > 1) t`,
      [TENANT_ID, ids],
    );
    const leftPushing = await q(
      A.db,
      `SELECT count(*)::int AS c FROM sync_outbox WHERE tenant_id=$1 AND status IN ('pushing','pending')`,
      [TENANT_ID],
    );
    check(
      "every sale applied exactly once after kill + lease recovery",
      hubCount[0]?.c === ids.length && hubDupes[0]?.c === 0 && leftPushing[0]?.c === 0,
      `applied=${hubCount[0]?.c}/${ids.length} dupes=${hubDupes[0]?.c} left=${leftPushing[0]?.c}`,
    );
  }

  // ---- D2: hub killed mid-drain ----
  section("D2. Hub SIGKILLed mid-drain restarts clean (no dupes)");
  {
    // 8 sales on a 10-piece roll: all must be able to win.
    const stock = await mkStock(A.port, DEV_A, 5000, 10);
    const cust = await mkCustomer(A.port, DEV_A, "Drill-D2");
    await syncUntilDrained(A.port, DEV_A);
    const ids = [];
    for (let i = 0; i < 8; i++) {
      const s = await mkSale(A.port, DEV_A, cust.id, {
        fabricId: stock.fab.id,
        colorId: stock.col.id,
        rollId: stock.roll.id,
        quantityKg: 5,
        pricePerKg: 1000,
      });
      ids.push(s.json.id);
    }
    const drainP = api(A.port, "POST", "/api/sync/run", { deviceId: DEV_A });
    await new Promise((r) => setTimeout(r, 700));
    killServer(hub);
    await drainP.catch(() => null);
    hub = startServer("hub", HUB.db, HUB.port, null, "drill-hub.log");
    await waitForHealth(HUB.port, "hub (restarted)");
    // The dead drain may have stranded units in `pushing` on the device;
    // expire their lease (labeled time-simulation, same as D1) so the next
    // drain can reclaim them instead of waiting out 5 wall-clock minutes.
    console.log("  (expiring stranded pushing leases after the hub death)");
    await q(
      A.db,
      `UPDATE sync_outbox SET updated_at = now() - interval '6 minutes' WHERE tenant_id=$1 AND status='pushing'`,
      [TENANT_ID],
    );
    await syncUntilDrained(A.port, DEV_A);
    const hubCount = await q(
      HUB.db,
      `SELECT count(*)::int AS c FROM invoices WHERE tenant_id=$1 AND id = ANY($2)`,
      [TENANT_ID, ids],
    );
    const hubDupes = await q(
      HUB.db,
      `SELECT count(*)::int AS c FROM (SELECT id, count(*) FROM invoices WHERE tenant_id=$1 AND id = ANY($2) GROUP BY id HAVING count(*) > 1) t`,
      [TENANT_ID, ids],
    );
    const devState = await q(
      A.db,
      `SELECT status, count(*)::int AS c FROM sync_outbox WHERE tenant_id=$1 AND entity_type='invoice' GROUP BY status`,
      [TENANT_ID],
    );
    check(
      "drain completes after hub restart with no loss and no dupes",
      hubCount[0]?.c === ids.length && hubDupes[0]?.c === 0,
      `applied=${hubCount[0]?.c}/${ids.length} dupes=${hubDupes[0]?.c} dev=${JSON.stringify(devState)}`,
    );
  }

  // ---- D3: restore-equivalence ----
  section("D3. A restored clone of the hub serves traffic (read + write)");
  {
    const before = await q(HUB.db, `SELECT count(*)::int AS c FROM invoices WHERE tenant_id=$1`, [
      TENANT_ID,
    ]);
    // TEMPLATE clone requires no live connections to the source: stop the hub
    // first (it restarts below for D4).
    killServer(hub);
    const c = await adminClient();
    await c.query(`DROP DATABASE IF EXISTS "${HUB2.db}" WITH (FORCE)`);
    await c.query(`CREATE DATABASE "${HUB2.db}" TEMPLATE "${HUB.db}"`);
    await c.end();
    hub = startServer("hub", HUB.db, HUB.port, null, "drill-hub.log");
    await waitForHealth(HUB.port, "hub (restarted for clone)");
    const hub2 = startServer("hub2", HUB2.db, HUB2.port, null, "drill-hub2.log");
    await waitForHealth(HUB2.port, "restored hub");
    // Repoint the device at the restored hub and prove read + write.
    killServer(devA);
    devA = startServer("A", A.db, A.port, `http://127.0.0.1:${HUB2.port}`, "drill-a.log");
    await waitForHealth(A.port, "device A (repointed)");
    const stock = await mkStock(A.port, DEV_A);
    const cust = await mkCustomer(A.port, DEV_A, "Drill-D3");
    const s = await mkSale(A.port, DEV_A, cust.id, {
      fabricId: stock.fab.id,
      colorId: stock.col.id,
      rollId: stock.roll.id,
      quantityKg: 5,
      pricePerKg: 1000,
    });
    await syncUntilDrained(A.port, DEV_A);
    const onRestored = await q(
      HUB2.db,
      `SELECT count(*)::int AS c FROM invoices WHERE tenant_id=$1 AND id=$2`,
      [TENANT_ID, s.json.id],
    );
    const restoredTotal = await q(
      HUB2.db,
      `SELECT count(*)::int AS c FROM invoices WHERE tenant_id=$1`,
      [TENANT_ID],
    );
    check(
      "restored hub holds prior history and accepts new writes",
      restoredTotal[0]?.c === before[0]?.c + 1 && onRestored[0]?.c === 1,
      `history=${restoredTotal[0]?.c}/${before[0]?.c + 1} new=${onRestored[0]?.c}`,
    );
    killServer(hub2);
    const cc = await adminClient();
    await cc.query(`DROP DATABASE IF EXISTS "${HUB2.db}" WITH (FORCE)`);
    await cc.end();
    // Repoint back at the original hub for D4.
    killServer(devA);
    devA = startServer("A", A.db, A.port, `http://127.0.0.1:${HUB.port}`, "drill-a.log");
    await waitForHealth(A.port, "device A (back on hub)");
    await syncUntilDrained(A.port, DEV_A);
  }

  // ---- D4: partition ----
  section("D4. Partition fails visibly, then converges with no loss");
  {
    const stock = await mkStock(A.port, DEV_A);
    const cust = await mkCustomer(A.port, DEV_A, "Drill-D4");
    const s = await mkSale(A.port, DEV_A, cust.id, {
      fabricId: stock.fab.id,
      colorId: stock.col.id,
      rollId: stock.roll.id,
      quantityKg: 5,
      pricePerKg: 1000,
    });
    killServer(hub);
    const dark = await api(A.port, "POST", "/api/sync/run", { deviceId: DEV_A });
    const visible = dark.json?.pullError != null || (dark.json?.failed ?? 0) > 0;
    const backlog = await q(
      A.db,
      `SELECT count(*)::int AS c FROM sync_outbox WHERE tenant_id=$1 AND status IN ('pending','pushing')`,
      [TENANT_ID],
    );
    check(
      "partitioned drain fails visibly with the backlog intact",
      visible && backlog[0]?.c >= 1,
      `pullError=${dark.json?.pullError != null} failed=${dark.json?.failed} backlog=${backlog[0]?.c}`,
    );
    hub = startServer("hub", HUB.db, HUB.port, null, "drill-hub.log");
    await waitForHealth(HUB.port, "hub (back)");
    await syncUntilDrained(A.port, DEV_A);
    const arrived = await q(
      HUB.db,
      `SELECT count(*)::int AS c FROM invoices WHERE tenant_id=$1 AND id=$2`,
      [TENANT_ID, s.json.id],
    );
    check(
      "sale converges after the partition heals",
      arrived[0]?.c === 1,
      `arrived=${arrived[0]?.c}`,
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
  for (const s of [...servers]) killServer(s);
  if (!KEEP) {
    const c = await adminClient();
    for (const { db } of [HUB, A]) await c.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
    await c.end();
    console.log("\n(databases dropped; pass --keep to retain them)");
  }
  return passed === results.length ? 0 : 1;
}

let exitCode = 1;
try {
  exitCode = await main();
} catch (err) {
  console.log("\nHARNESS ERROR:", err);
} finally {
  for (const s of [...servers]) {
    try {
      s.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
  if (!KEEP) {
    try {
      const c = await adminClient();
      for (const db of ["drill_hub", "drill_dev_a", "drill_restored"]) {
        await c.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
      }
      await c.end();
    } catch {
      /* ignore */
    }
  }
}
process.exit(exitCode);
