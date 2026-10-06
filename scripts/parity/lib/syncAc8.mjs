/**
 * AC-8 sync topology and scenario (specs/001-desktop-sqlite-engine T102/T103, quickstart §6).
 *
 *   Device A ──► proxy A ─┐
 *                         ├─► PostgreSQL hub (unchanged cloud code path, non-desktop)
 *   Device B ──► proxy B ─┘
 *
 * Devices run on the engine under test (`postgres` or `sqlite`); the hub is always PostgreSQL. The
 * proxies record every device↔hub exchange (push batches, pull pages, number blocks) for the golden
 * wire comparison. Nothing is mocked: real servers, real migrations, real sync code.
 *
 * Scenario (deterministic, sequential HTTP — identical on both engines):
 *   online   A and B reserve number blocks; A creates 3 customers, 1 fabric, 1 color, 6 rolls and one
 *            shared roll RS; A pushes, B pulls.
 *   offline  A creates 20 sale invoices (the last one consumes RS), B creates 30 (the last one also
 *            consumes RS), and both edit customer C0 (same-record edit).
 *   reconnect  A, B, A, B sync until drained; open conflicts are reported (never auto-resolved here).
 */
import { spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";
import { BACKEND, REPO, readTables } from "./engine.mjs";

const requireBackend = createRequire(join(BACKEND, "package.json"));
const pg = requireBackend("pg");
const { SignJWT } = requireBackend("jose");

export const TENANT_ID = "11111111-1111-4111-8111-111111111111";
export const USER_ID = "22222222-2222-4222-8222-222222222222";
export const DEV_A = "33333333-3333-4333-8333-333333333333";
export const DEV_B = "44444444-4444-4444-8444-444444444444";

export const JWT_HUB = "ac8-hub-sync-jwt-secret-key-min-32-chars!!";
export const JWT_A = "ac8-device-a-offline-sync-jwt-secret-key!!";
export const JWT_B = "ac8-device-b-offline-sync-jwt-secret-key!!";
const APP_MASTER_KEY = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=";
const TEMPLATE_DB = "ac8_tpl";
export const DATE = "2026-03-01";

/** PG admin URL on the throwaway cluster (backend/.env.test re-pointed at 55432/postgres). Never printed. */
export function pgAdminUrl() {
  if (process.env.PARITY_PG_URL) return process.env.PARITY_PG_URL;
  const line = readFileSync(join(BACKEND, ".env.test"), "utf8").split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
  if (!line) throw new Error("PARITY_PG_URL unset and backend/.env.test has no DATABASE_URL");
  const u = new URL(line.slice("DATABASE_URL=".length).trim().replace(/^"|"$/g, ""));
  u.port = process.env.PARITY_PG_PORT ?? "55432";
  u.pathname = "/postgres";
  return u.toString();
}

export function dbUrl(admin, db) {
  const u = new URL(admin);
  u.pathname = `/${db}`;
  return u.toString();
}

export async function withClient(url, fn) {
  const c = new pg.Client({ connectionString: url });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

// ─── databases ────────────────────────────────────────────────────────────

/** Migrated PG template (drizzle-kit migrate, ~2 min); reused unless `refresh`. */
export async function ensurePgTemplate(admin, refresh) {
  const exists = await withClient(admin, (c) => c.query("SELECT 1 FROM pg_database WHERE datname = $1", [TEMPLATE_DB]));
  if (exists.rows.length && !refresh) {
    const n = await withClient(dbUrl(admin, TEMPLATE_DB), (c) =>
      c.query("SELECT count(*)::int AS c FROM information_schema.tables WHERE table_schema = 'public' AND table_name IN ('sync_outbox','sync_inbox','sync_devices','sync_device_authorized_users')"),
    );
    if (n.rows[0].c === 4) return;
  }
  await withClient(admin, async (c) => {
    await c.query(`DROP DATABASE IF EXISTS "${TEMPLATE_DB}" WITH (FORCE)`);
    await c.query(`CREATE DATABASE "${TEMPLATE_DB}" TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`);
  });
  console.log("[ac8] migrating the PG template (one-off, ~2 min)…");
  const r = spawnSync(process.execPath, ["node_modules/drizzle-kit/bin.cjs", "migrate"], {
    cwd: BACKEND,
    env: { ...process.env, DATABASE_URL: dbUrl(admin, TEMPLATE_DB), NODE_ENV: "test" },
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`template migrate failed:\n${(r.stdout ?? "") + (r.stderr ?? "")}`.slice(-3000));
}

export async function clonePg(admin, db) {
  await withClient(admin, async (c) => {
    await c.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
    await c.query(`CREATE DATABASE "${db}" TEMPLATE "${TEMPLATE_DB}"`);
  });
}

export async function seedPg(url, label) {
  await withClient(url, async (c) => {
    await c.query(
      `INSERT INTO tenants (id, name, slug, status, license_status, license_type)
       VALUES ($1, 'AC-8 Tenant', $2, 'active', 'no_license', 'trial')`,
      [TENANT_ID, `ac8-${label}`],
    );
    await c.query(
      `INSERT INTO users (id, tenant_id, name, email, password_hash, role, active)
       VALUES ($1, $2, 'AC-8 Admin', $3, 'not-used-tokens-are-minted', 'admin', true)`,
      [USER_ID, TENANT_ID, `admin-${label}@ac8.local`],
    );
    for (const [id, name] of [[DEV_A, "device-a"], [DEV_B, "device-b"]]) {
      await c.query(
        `INSERT INTO sync_devices (id, tenant_id, device_fingerprint, platform, hostname, label, last_seen_by_user_id, authorized_user_ids)
         VALUES ($1, $2, $3, 'windows', $4, $4, $5, ARRAY[$5]::uuid[])`,
        [id, TENANT_ID, `fp-${name}`, name, USER_ID],
      );
      await c.query(`INSERT INTO sync_device_authorized_users (tenant_id, device_id, user_id) VALUES ($1, $2, $3)`, [TENANT_ID, id, USER_ID]);
    }
    await c.query(
      `INSERT INTO setup_wizard_state (tenant_id, current_step, completed_steps, is_completed, completed_at)
       VALUES ($1, 'done', ARRAY['welcome'], true, now())`,
      [TENANT_ID],
    );
  });
}

/** Fresh SQLite device database through the production FRESH boot, then the same seed rows as PG. */
export function createSqlite(path, label) {
  const r = spawnSync(process.execPath, [join(BACKEND, "node_modules/tsx/dist/cli.mjs"), join(REPO, "scripts/parity/lib/sqliteFresh.mts"), path], {
    cwd: BACKEND,
    env: { ...process.env, DB_ENGINE: "sqlite", SQLITE_PATH: path },
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`sqliteFresh failed:\n${(r.stdout ?? "") + (r.stderr ?? "")}`.slice(-3000));
  const Database = requireBackend("better-sqlite3");
  const db = new Database(path);
  const now = new Date().toISOString().replace("Z", "000Z");
  try {
    db.exec("BEGIN IMMEDIATE");
    db.prepare(`INSERT INTO tenants (id, name, slug, status, license_status, license_type) VALUES (?, 'AC-8 Tenant', ?, 'active', 'no_license', 'trial')`).run(TENANT_ID, `ac8-${label}`);
    db.prepare(`INSERT INTO users (id, tenant_id, name, email, password_hash, role, active) VALUES (?, ?, 'AC-8 Admin', ?, 'not-used-tokens-are-minted', 'admin', 1)`).run(USER_ID, TENANT_ID, `admin-${label}@ac8.local`);
    for (const [id, name] of [[DEV_A, "device-a"], [DEV_B, "device-b"]]) {
      db.prepare(
        `INSERT INTO sync_devices (id, tenant_id, device_fingerprint, platform, hostname, label, last_seen_by_user_id, authorized_user_ids)
         VALUES (?, ?, ?, 'windows', ?, ?, ?, ?)`,
      ).run(id, TENANT_ID, `fp-${name}`, name, name, USER_ID, JSON.stringify([USER_ID]));
      db.prepare(`INSERT INTO sync_device_authorized_users (tenant_id, device_id, user_id) VALUES (?, ?, ?)`).run(TENANT_ID, id, USER_ID);
    }
    db.prepare(`INSERT INTO setup_wizard_state (tenant_id, current_step, completed_steps, is_completed, completed_at) VALUES (?, 'done', '["welcome"]', 1, ?)`).run(TENANT_ID, now);
    db.exec("COMMIT");
  } finally {
    db.close();
  }
}

// ─── processes ───────────────────────────────────────────────────────────

export function nodeEnv(extra) {
  const env = { ...process.env, NODE_ENV: "test", LOG_LEVEL: "info", RATE_LIMIT_RPS: "100000", RATE_LIMIT_WINDOW_MS: "60000", HOST: "127.0.0.1", APP_MASTER_KEY, ...extra };
  // Never inherit an engine/desktop identity from the caller's shell (see verify-sync-multidevice.mjs:
  // DESKTOP_DEPLOY must be deleted, not blanked; CENTRAL_SYNC_URL "" fails URL validation).
  for (const k of ["DESKTOP_DEPLOY", "DESKTOP_PIPE", "TEST_DB_URL", "MOTARD_STARTUP_STATE", "DESKTOP_SEED_PATH"]) if (!(k in extra)) delete env[k];
  if (!extra.CENTRAL_SYNC_URL) delete env.CENTRAL_SYNC_URL;
  if (extra.DB_ENGINE === "sqlite") delete env.DATABASE_URL;
  else delete env.SQLITE_PATH;
  return env;
}

/** serverEntry: a packaged server.mjs (T119 runs the release candidate) instead of the source tree. */
export function startNode(name, env, logPath, serverEntry) {
  const out = openSync(logPath, "w");
  const args = serverEntry ? [serverEntry] : [join(BACKEND, "node_modules/tsx/dist/cli.mjs"), "src/presentation/server.ts"];
  const childEnv = serverEntry && env.DB_ENGINE === "sqlite" ? { ...env, DESKTOP_SQLITE_MIGRATIONS_FOLDER: join(dirname(serverEntry), "sqlite-migrations") } : env;
  const child = spawn(process.execPath, args, {
    cwd: BACKEND,
    env: childEnv,
    stdio: ["ignore", out, out],
  });
  child.__name = name;
  child.__log = logPath;
  return child;
}

export async function waitHealthy(port, child, timeoutMs = 240_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health/live`, { signal: AbortSignal.timeout(2000) });
      if (r.ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  const tail = existsSync(child.__log) ? readFileSync(child.__log, "utf8").slice(-3000) : "";
  throw new Error(`${child.__name} did not become healthy on :${port}\n${tail}`);
}

export function kill(child) {
  if (!child || child.exitCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
  else child.kill("SIGKILL");
}

/** Recording reverse proxy in front of the hub: one per device, so every exchange is attributed. */
function startProxy(port, hubPort, device, wire) {
  const server = createServer((req, res) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", async () => {
      const body = Buffer.concat(chunks);
      const headers = { ...req.headers };
      delete headers.host;
      delete headers["content-length"];
      try {
        const r = await fetch(`http://127.0.0.1:${hubPort}${req.url}`, {
          method: req.method,
          headers,
          body: req.method === "GET" || req.method === "HEAD" ? undefined : body,
        });
        const text = await r.text();
        wire.push({ device, method: req.method, path: req.url, status: r.status, request: parse(body.toString("utf8")), response: parse(text) });
        res.writeHead(r.status, { "content-type": r.headers.get("content-type") ?? "application/json" });
        res.end(text);
      } catch (e) {
        wire.push({ device, method: req.method, path: req.url, status: 0, error: String(e) });
        res.writeHead(502);
        res.end();
      }
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve(server)));
}

function parse(text) {
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

export async function mintToken(secret) {
  return new SignJWT({ sub: USER_ID, tenantId: TENANT_ID, role: "admin", jti: randomUUID(), type: "access" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 7200)
    .sign(new TextEncoder().encode(secret));
}

export function client(port, token, deviceId) {
  return async (method, path, body) => {
    const headers = { Authorization: `Bearer ${token}`, "Content-Type": "application/json" };
    if (deviceId) headers["X-Sync-Device-Id"] = deviceId;
    if (method !== "GET") headers["Idempotency-Key"] = randomUUID();
    const r = await fetch(`http://127.0.0.1:${port}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await r.text();
    return { status: r.status, json: parse(text), text };
  };
}

export async function must(call, label, method, path, body) {
  const r = await call(method, path, body);
  if (r.status >= 300) throw new Error(`${label}: HTTP ${r.status} ${r.text.slice(0, 400)}`);
  return r.json;
}

export async function syncUntilDrained(call, maxRounds = 8) {
  const rounds = [];
  for (let i = 0; i < maxRounds; i += 1) {
    const r = await call("POST", "/api/sync/run");
    rounds.push(r.status === 200 ? r.json : { status: r.status, body: r.text.slice(0, 300) });
    if (r.status !== 200) break;
    const j = r.json;
    if ((j.pushed ?? 0) === 0 && (j.failed ?? 0) === 0 && (j.rejected ?? 0) === 0 && (j.pull?.pulled ?? 0) === 0) break;
  }
  return rounds;
}

// ─── run ─────────────────────────────────────────────────────────────────

/**
 * @param {{ deviceEngine: "postgres"|"sqlite", basePort?: number, refreshTemplate?: boolean, keep?: boolean, restoreScenario?: boolean, deviceServer?: string }} opts
 * @returns {Promise<{ wire: object[], log: object[], tables: { hub: object, a: object, b: object }, conflicts: object, work: string }>}
 */
export async function runAc8(opts) {
  const engine = opts.deviceEngine;
  const base = opts.basePort ?? 8190;
  const ports = { hub: base + 1, a: base + 2, b: base + 3, proxyA: base + 4, proxyB: base + 5 };
  const admin = pgAdminUrl();
  const tag = `${engine === "sqlite" ? "sq" : "pg"}_${Date.now()}`;
  const work = mkdtempSync(join(tmpdir(), `motard-ac8-${engine}-`));
  const dbs = { hub: `ac8_hub_${tag}`, a: `ac8_a_${tag}`, b: `ac8_b_${tag}` };
  const children = [];
  const proxies = [];
  const wire = [];
  const log = [];
  const step = (label, data) => log.push({ label, ...(data === undefined ? {} : { data }) });

  await ensurePgTemplate(admin, Boolean(opts.refreshTemplate));
  await clonePg(admin, dbs.hub);
  await seedPg(dbUrl(admin, dbs.hub), "hub");
  const handles = { hub: { engine: "postgres", env: { DATABASE_URL: dbUrl(admin, dbs.hub) } } };
  for (const d of ["a", "b"]) {
    if (engine === "sqlite") {
      const path = join(work, d, "motard.db");
      mkdirSync(join(work, d), { recursive: true });
      createSqlite(path, d);
      handles[d] = { engine: "sqlite", env: { SQLITE_PATH: path } };
    } else {
      await clonePg(admin, dbs[d]);
      await seedPg(dbUrl(admin, dbs[d]), d);
      handles[d] = { engine: "postgres", env: { DATABASE_URL: dbUrl(admin, dbs[d]) } };
    }
  }

  const hubToken = await mintToken(JWT_HUB);
  try {
    const hub = startNode("hub", nodeEnv({ DB_ENGINE: "postgres", DATABASE_URL: handles.hub.env.DATABASE_URL, PORT: String(ports.hub), JWT_SECRET: JWT_HUB }), join(work, "hub.log"));
    children.push(hub);
    await waitHealthy(ports.hub, hub);
    proxies.push(await startProxy(ports.proxyA, ports.hub, "A", wire));
    proxies.push(await startProxy(ports.proxyB, ports.hub, "B", wire));

    const devices = {};
    const deviceConfig = { a: [JWT_A, ports.proxyA, DEV_A], b: [JWT_B, ports.proxyB, DEV_B] };
    const startDevice = async (d, logSuffix = "") => {
      const [secret, proxyPort, devId] = deviceConfig[d];
      const engineEnv = engine === "sqlite"
        ? { DB_ENGINE: "sqlite", SQLITE_PATH: handles[d].env.SQLITE_PATH, MOTARD_STARTUP_STATE: "OPEN_EXISTING" }
        : { DB_ENGINE: "postgres", DATABASE_URL: handles[d].env.DATABASE_URL };
      const child = startNode(d.toUpperCase(), nodeEnv({
        ...engineEnv,
        PORT: String(ports[d]),
        JWT_SECRET: secret,
        CENTRAL_SYNC_URL: `http://127.0.0.1:${proxyPort}`,
        HUB_SYNC_ACCESS_TOKEN: hubToken,
      }), join(work, `${d}${logSuffix}.log`), opts.deviceServer);
      children.push(child);
      await waitHealthy(ports[d], child);
      devices[d] ??= client(ports[d], await mintToken(secret), devId);
      devices[d].deviceId = devId;
      devices[d].child = child;
    };
    const stopDevice = async (d) => {
      kill(devices[d].child);
      children.splice(children.indexOf(devices[d].child), 1);
      await new Promise((r) => setTimeout(r, 1500));
    };
    for (const d of ["a", "b"]) await startDevice(d);
    const { a: A, b: B } = devices;

    // ── online: number blocks, master data on A, A pushes, B pulls ──
    const BLOCKS = ["customer", "supplier", "invoice", "invoice_entry"];
    for (const [name, dev] of [["A", A], ["B", B]]) {
      const r = await must(dev, `${name} number blocks`, "POST", "/api/sync/number-blocks/ensure", { syncDeviceId: dev.deviceId, entityTypes: BLOCKS });
      step(`${name}.number-blocks`, r);
    }
    const customers = [];
    for (let i = 0; i < 3; i++) customers.push((await must(A, "customer", "POST", "/api/customers", { name: `AC8 Customer ${i}` })).id);
    const fabric = (await must(A, "fabric", "POST", "/api/inventory/fabrics", { name: "AC8 Fabric" })).id;
    const color = (await must(A, "color", "POST", "/api/inventory/colors", { fabricId: fabric, name: "AC8 Color" })).id;
    const roll = async (rollNo, kg) =>
      (await must(A, `roll ${rollNo}`, "POST", "/api/inventory/rolls", { colorId: color, rollNo, initialKg: kg, pieces: 50, pricePerKg: 2, currency: "USD", entryDate: DATE })).id;
    const rolls = [];
    for (let i = 0; i < 6; i++) rolls.push(await roll(`AC8-R${i}`, 500));
    const shared = await roll("AC8-RS", 100);
    step("online.A.sync", await syncUntilDrained(A));
    step("online.B.sync", await syncUntilDrained(B));
    const bCustomers = await must(B, "B customers", "GET", "/api/customers?limit=50");
    step("online.B.customers", (bCustomers.data ?? bCustomers).length);

    // ── offline: 20 invoices on A, 30 on B, same-roll consumption, same-record edit ──
    const sale = (dev, label, customerId, rollId, kg, price, paid) =>
      must(dev, label, "POST", "/api/invoices", {
        type: "sale",
        date: DATE,
        partyId: customerId,
        partyType: "customer",
        currency: "USD",
        lines: [{ fabricId: fabric, colorId: color, rollId, quantityKg: kg, pieces: 1, pricePerKg: price }],
        paid,
      });
    for (let i = 0; i < 19; i++) await sale(A, `A invoice ${i}`, customers[i % 3], rolls[i % 3], 5, 4, i % 2 ? 20 : 0);
    await sale(A, "A invoice RS", customers[0], shared, 30, 4, 0);
    for (let i = 0; i < 29; i++) await sale(B, `B invoice ${i}`, customers[i % 3], rolls[3 + (i % 3)], 4, 5, i % 3 === 0 ? 20 : 0);
    await sale(B, "B invoice RS", customers[1], shared, 30, 5, 0);
    for (const [name, dev, phone] of [["A", A, "0911-000-A"], ["B", B, "0922-000-B"]]) {
      const cur = await must(dev, `${name} read C0`, "GET", `/api/customers/${customers[0]}`);
      const r = await dev("PUT", `/api/customers/${customers[0]}`, { phone, expectedVersion: cur.version });
      step(`offline.${name}.edit-C0`, { status: r.status, version: r.json?.version ?? null });
    }

    // ── reconnect ──
    for (const [name, dev] of [["A", A], ["B", B], ["A", A], ["B", B]]) step(`reconnect.${name}.sync`, await syncUntilDrained(dev));

    // The same-record edit opens a conflict on the hub (first write wins; the later edit waits for
    // an operator). Resolve it the way an operator would — keep the server version — then let both
    // devices sync again so the losing device converges.
    const hubApi = client(ports.hub, hubToken);
    const conflicts = {};
    for (const [name, dev] of [["A", A], ["B", B], ["hub", hubApi]]) {
      const r = await dev("GET", "/api/sync/conflicts");
      conflicts[name] = r.status === 200 ? r.json : { status: r.status };
    }
    const resolutions = [];
    for (const c of conflicts.hub?.items ?? []) {
      if (c.status !== "open") continue;
      const r = await hubApi("POST", "/api/sync/conflicts/resolve", { conflictId: c.id, decision: "keep-server", note: "AC-8 harness" });
      resolutions.push({ entityType: c.entityType, operation: c.operation, status: r.status });
    }
    step("resolve.keep-server", resolutions);
    for (const [name, dev] of [["B", B], ["A", A], ["B", B]]) step(`converge.${name}.sync`, await syncUntilDrained(dev));

    // Editing after a conflict: the device that LOST it edits the same customer again. The edit must
    // reach the hub and the other device (customer/supplier editing must keep syncing).
    {
      const cur = await must(B, "B read C0 after conflict", "GET", `/api/customers/${customers[0]}`);
      const r = await B("PUT", `/api/customers/${customers[0]}`, { name: "AC8 Customer 0 (renamed on B)", phone: "0933-000-B", expectedVersion: cur.version });
      step("post-conflict.B.edit-C0", { status: r.status });
      for (const [name, dev] of [["B", B], ["A", A]]) step(`post-conflict.${name}.sync`, await syncUntilDrained(dev));
    }
    const status = {};
    for (const [name, dev] of [["A", A], ["B", B]]) status[name] = (await dev("GET", "/api/sync/status")).json;
    step("final.sync-status", status);

    // ── T110: restore on a synced device (SQLite desktops; owner decision option b) ──
    let restoreReport = null;
    if (opts.restoreScenario) {
      if (engine !== "sqlite") throw new Error("restoreScenario needs SQLite desktops");
      const helper = (d, args) => {
        const r = spawnSync(process.execPath, [join(BACKEND, "node_modules/tsx/dist/cli.mjs"), join(REPO, "scripts/parity/lib/sqliteBackupRestore.mts"), ...args], {
          cwd: BACKEND,
          env: nodeEnv({ DB_ENGINE: "sqlite", SQLITE_PATH: handles[d].env.SQLITE_PATH, MOTARD_STARTUP_STATE: "OPEN_EXISTING", JWT_SECRET: JWT_B }),
          encoding: "utf8",
        });
        if (r.status !== 0) throw new Error(`sqliteBackupRestore ${args[0]} failed:\n${(r.stdout ?? "") + (r.stderr ?? "")}`.slice(-3000));
        return JSON.parse(r.stdout.trim().split(/\r?\n/).at(-1));
      };
      // R1: B works offline — these units are PENDING in the snapshot
      const pendingAtBackup = [];
      for (let i = 0; i < 3; i++) pendingAtBackup.push((await sale(B, `B pre-backup ${i}`, customers[2], rolls[3], 2, 5, 0)).id);
      // R2: snapshot of B
      await stopDevice("b");
      const snapshot = helper("b", ["backup"]);
      await startDevice("b", "-2");
      // R3: B keeps working after the backup and syncs it (the hub now holds the 3 pending units too)
      const postBackup = [];
      for (let i = 0; i < 5; i++) postBackup.push((await sale(B, `B post-backup ${i}`, customers[0], rolls[4], 2, 5, 10)).id);
      step("restore.B.sync-before", await syncUntilDrained(B));
      // R4: a peer writes newer data
      const peerNewer = [];
      for (let i = 0; i < 2; i++) peerNewer.push((await sale(A, `A newer ${i}`, customers[1], rolls[0], 2, 4, 0)).id);
      step("restore.A.sync", await syncUntilDrained(A));
      // R5: restore the snapshot on B (wipes the post-backup work locally)
      await stopDevice("b");
      step("restore.B.restore", helper("b", ["restore", snapshot.path]));
      await startDevice("b", "-3");
      const wireMark = wire.length;
      // R6: sync until the restore reconcile finishes
      const runs = [];
      for (let i = 0; i < 10; i++) {
        const r = await B("POST", "/api/sync/run");
        runs.push(r.status === 200 ? r.json : { status: r.status, body: r.text.slice(0, 300) });
        if (r.status !== 200 || !r.json?.restore?.paused) break;
      }
      step("restore.B.runs", runs);
      step("restore.B.status", (await B("GET", "/api/sync/status")).json?.restore ?? null);
      // R7: life goes on under the new identity
      const postRestore = (await sale(B, "B post-restore", customers[2], rolls[5], 2, 5, 0)).id;
      step("restore.B.sync-after", await syncUntilDrained(B));
      step("restore.A.sync-after", await syncUntilDrained(A));
      step("restore.B.sync-final", await syncUntilDrained(B));
      const pushedAfter = wire.slice(wireMark).filter((x) => x.device === "B" && x.path === "/api/sync/push").map((x) => ({ entityId: x.request?.entityId, opId: x.request?.opId, syncDeviceId: x.request?.syncDeviceId }));
      restoreReport = { pendingAtBackup, postBackup, peerNewer, postRestore, pushedAfter, wireMark };
    }

    for (const c of children) kill(c);
    children.length = 0;
    await new Promise((r) => setTimeout(r, 800));
    const tables = { hub: await readTables(handles.hub), a: await readTables(handles.a), b: await readTables(handles.b) };
    return { wire, log, tables, conflicts, work, ids: { customers, rolls, shared, fabric, color }, restoreReport };
  } finally {
    for (const c of children) kill(c);
    for (const p of proxies) p.close();
    if (!opts.keep) {
      await withClient(admin, async (c) => {
        for (const db of Object.values(dbs)) await c.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
      }).catch(() => {});
    }
  }
}

/**
 * Tables that are per-node by design and never converge: sync transport state, local caches,
 * identity/licensing, audit of local HTTP calls. Everything else is business state and must be
 * identical on A, B and the hub.
 */
export const NODE_LOCAL_TABLES = new Set([
  "sync_outbox", "sync_inbox", "sync_state", "sync_conflicts", "sync_resource_claims", "sync_devices",
  "sync_device_authorized_users", "sync_tombstones", "document_number_blocks", "audit_logs", "notifications",
  "idempotency_keys", "revoked_tokens", "secrets", "device_registrations", "license_activations", "licenses",
  "license_audit_events", "server_installations", "invitation_codes", "setup_wizard_state", "tenants", "users",
  "print_jobs", "backup_runs",
  // device-side request idempotency and per-node document counters (each node numbers from its own block)
  "financial_operations", "document_sequences",
]);

/**
 * Column names that record when/how THIS node wrote the row, not business facts. `client_operation_id`
 * is the device-side idempotency key of the request that created the document; the hub stores NULL.
 */
export const NODE_LOCAL_COLUMN = /^(created_at|updated_at|synced_at|materialized_at|applied_at|received_at|client_operation_id)$/;

/**
 * Rows every node DERIVES itself when it materializes a document (lines, ledger legs, stock movements):
 * their primary keys are minted locally, so they are compared by content, not by id.
 */
export const DERIVED_ID_TABLES = new Set(["invoice_lines", "ledger_entries", "stock_movements"]);

/** Business-table projection used for the A = B = hub comparison. */
export function businessState(tables) {
  const out = {};
  for (const [t, rows] of Object.entries(tables)) {
    if (NODE_LOCAL_TABLES.has(t)) continue;
    const dropId = DERIVED_ID_TABLES.has(t);
    out[t] = rows
      .map((r) => Object.fromEntries(Object.entries(r).filter(([k]) => !NODE_LOCAL_COLUMN.test(k) && !(dropId && k === "id")).sort(([x], [y]) => (x < y ? -1 : 1))))
      .map((r) => JSON.stringify(r))
      .sort();
  }
  return out;
}

/** Differences between two business states, as readable lines (empty = identical). */
export function diffStates(left, right, leftName, rightName, max = 40) {
  const lines = [];
  for (const t of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
    const l = new Set(left[t] ?? []);
    const r = new Set(right[t] ?? []);
    const onlyL = [...l].filter((x) => !r.has(x));
    const onlyR = [...r].filter((x) => !l.has(x));
    if (!onlyL.length && !onlyR.length) continue;
    lines.push(`${t}: ${l.size} rows on ${leftName}, ${r.size} on ${rightName}; ${onlyL.length} only on ${leftName}, ${onlyR.length} only on ${rightName}`);
    for (const x of onlyL.slice(0, 3)) lines.push(`  ${leftName}: ${x.slice(0, 400)}`);
    for (const x of onlyR.slice(0, 3)) lines.push(`  ${rightName}: ${x.slice(0, 400)}`);
    if (lines.length > max) break;
  }
  return lines;
}
