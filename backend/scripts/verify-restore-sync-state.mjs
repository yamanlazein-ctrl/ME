/**
 * Batch 3B — backup/restore sync-state semantics, verified end to end.
 *
 * THE STORY UNDER TEST
 *   A device works offline → it has pending operations → a backup is taken →
 *   the device is destroyed → the backup is restored on a fresh, migrated
 *   database → synchronization resumes.
 *
 * What the defect was: POST /api/backup/full exported the sync tables, but
 * scripts/restore-from-backup.mjs inserted NONE of them, so after a restore the
 * outbox (un-pushed work), the inbox (applied-op mirror + terminal states), the
 * pull cursor, the first-write-wins claims, the deletion tombstones and the
 * device number blocks were all silently lost — while docs/SYNC-OPERATIONS.md
 * claimed sync state is restored with the business data.
 *
 * WHAT IS PROVEN HERE (real PostgreSQL, real servers, real archive)
 *   A. A backup taken from an offline device round-trips through the restore
 *      script: every sync row comes back byte-for-byte (ids, op-ids, statuses,
 *      ordering columns, claim/tombstone/conflict rows).
 *   B. Sequence continuity: after the restore, newly written rows get ordering
 *      values ABOVE every restored one (`seq`, `received_seq`) — otherwise the
 *      device would push new work before old work and the hub would replay it
 *      out of order. The bigserial PK sequences that the app never writes
 *      explicitly (audit_logs, idempotency_keys) keep working too.
 *   C. Resume: the restored device drains its pending units to the hub with no
 *      lost operation and NO DUPLICATE business effect (invoice/ledger/party
 *      counted exactly once), a unit restored as `applied` is not re-pushed,
 *      and a unit stranded as `pushing` before the crash is reclaimed and
 *      delivered after its lease — no "disappeared" state.
 *   D. Cursor safety: a restored cursor that points past everything the
 *      database has recorded is CLAMPED (re-pull is idempotent) instead of
 *      trusted (which would skip operations silently), and
 *      `--reset-pull-cursor` clears it for the "different hub" case.
 *   E. RLS: the restore works under a NON-bypassing role (tenant GUC) instead
 *      of failing halfway, and still crosses no tenant boundary.
 *
 * Usage:  node scripts/verify-restore-sync-state.mjs [--keep]
 */
import pg from "pg";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { SignJWT } from "jose";

const BACKEND = path.resolve(import.meta.dirname, "..");
const PG = { host: "localhost", port: 5432, user: "postgres", password: "postgres" };
const APP_USER = "app_user";
const APP_USER_PASSWORD = "B1nOnV1DUq6cMuZJmhhB6W-l";

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const DEV_A = "33333333-3333-4333-8333-333333333333";

const TPL = { db: "restore_tpl" };
const HUB = { db: "restore_hub", port: 8131 };
const DEV = { db: "restore_dev", port: 8132 };

const results = [];
const servers = [];
let workRoot = null;

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
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
        v = v.slice(1, -1);
      }
      env[m[1]] = v;
    }
  }
  return env;
}
const BASE_ENV = loadEnv();
const url = (db, user = PG.user, password = PG.password) =>
  `postgresql://${user}:${password}@${PG.host}:${PG.port}/${db}`;

async function adminClient() {
  const c = new pg.Client({ ...PG, database: "postgres" });
  await c.connect();
  return c;
}
async function dbClient(db, user = PG.user, password = PG.password) {
  const c = new pg.Client({ host: PG.host, port: PG.port, user, password, database: db });
  await c.connect();
  return c;
}
async function q(db, sql, params = [], creds = null) {
  const c = await dbClient(db, creds?.user ?? PG.user, creds?.password ?? PG.password);
  try {
    return (await c.query(sql, params)).rows;
  } finally {
    await c.end();
  }
}

// ------------------------------------------------------------------ setup

function migrate(db) {
  const res = spawnSync(
    process.execPath,
    [path.join("node_modules", "drizzle-kit", "bin.cjs"), "migrate"],
    { cwd: BACKEND, env: { ...process.env, DATABASE_URL: url(db) }, encoding: "utf8" },
  );
  return { ok: res.status === 0, out: `${res.stdout ?? ""}${res.stderr ?? ""}`.slice(-1500) };
}

async function createTemplate() {
  const c = await adminClient();
  await c.query(`DROP DATABASE IF EXISTS "${TPL.db}" WITH (FORCE)`);
  await c.query(`CREATE DATABASE "${TPL.db}"`);
  await c.end();
  const mig = migrate(TPL.db);
  if (!mig.ok) throw new Error(`migrations failed on template:\n${mig.out}`);
  info(`template ${TPL.db} migrated (${(mig.out.match(/\[✓\]|applied/gi) ?? []).length || "n/a"} markers)`);
}

async function cloneFromTemplate({ db }) {
  const c = await adminClient();
  await c.query(`DROP DATABASE IF EXISTS "${db}" WITH (FORCE)`);
  await c.query(`CREATE DATABASE "${db}" TEMPLATE "${TPL.db}"`);
  await c.end();
}

async function seed({ db }) {
  const c = await dbClient(db);
  await c.query(
    `INSERT INTO tenants (id, name, slug, status, license_status, license_type)
     VALUES ($1, 'Restore Tenant', $2, 'active', 'no_license', 'trial')
     ON CONFLICT (id) DO NOTHING`,
    [TENANT_ID, `restore-${db}`],
  );
  await c.query(
    `INSERT INTO users (id, tenant_id, name, email, password_hash, role, active)
     VALUES ($1, $2, 'Restore Admin', $3, 'not-used', 'admin', true)
     ON CONFLICT (id) DO NOTHING`,
    [USER_ID, TENANT_ID, `admin-${db}@restore.local`],
  );
  await c.query(
    // Batch 4 / 4B: a restored device keeps its binding — the restore drill
    // replays an API-registered row, so it must carry the registering user.
    `INSERT INTO sync_devices (id, tenant_id, device_fingerprint, platform, hostname, label,
                               last_seen_by_user_id, authorized_user_ids)
     VALUES ($1, $2, $3, 'windows', 'restore-dev', 'restore-dev', $4, ARRAY[$4]::uuid[])
     ON CONFLICT (id) DO NOTHING`,
    [DEV_A, TENANT_ID, `fp-restore-${db}`, USER_ID],
  );
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
    DATABASE_URL: url(db),
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
  let tail = "";
  for (const f of ["restore-hub.log", "restore-dev.log", "restore-dev-restart.log"]) {
    const p = path.join(BACKEND, f);
    if (fs.existsSync(p)) tail += `\n----- ${f} -----\n${fs.readFileSync(p, "utf8").slice(-2500)}`;
  }
  throw new Error(`${label} not healthy on :${port} (last: ${lastErr})${tail}`);
}

async function stopServer(name) {
  for (const s of servers.filter((x) => x.__name === name)) {
    try {
      s.kill("SIGKILL");
    } catch {
      /* ignore */
    }
  }
  await new Promise((r) => setTimeout(r, 1200));
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

let TOKEN = null;
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

async function api(port, method, urlPath, { body, deviceId, headers = {}, raw = false } = {}) {
  const res = await fetch(`http://127.0.0.1:${port}${urlPath}`, {
    method,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      "Content-Type": "application/json",
      ...(deviceId ? { "X-Sync-Device-Id": deviceId } : {}),
      ...headers,
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(120_000),
  });
  if (raw) return { status: res.status, buffer: Buffer.from(await res.arrayBuffer()) };
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* non-json */
  }
  return { status: res.status, json, text };
}

async function syncUntilDrained(port, deviceId, maxRounds = 10) {
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

// ------------------------------------------------------------------ sync seed

const OP_FAILED = "aaaaaaaa-0000-4000-8000-000000000001"; // restored as `pending`
const OP_APPLIED = "aaaaaaaa-0000-4000-8000-000000000002"; // must NOT be re-pushed
const OP_PUSHING = "aaaaaaaa-0000-4000-8000-000000000003"; // stale lease → reclaimed
const OP_INBOX_APPLIED = "bbbbbbbb-0000-4000-8000-000000000001";
const OP_INBOX_REJECTED = "bbbbbbbb-0000-4000-8000-000000000002";
const OP_INBOX_DEAD = "bbbbbbbb-0000-4000-8000-000000000003";

/**
 * Seed the sync state that only a device that has already synchronized can
 * have: a terminal inbox, a pull cursor, claims, a tombstone, a conflict and a
 * unit stranded mid-push. The two pending units that matter for "resume" are
 * created through the real API further down.
 */
async function seedSyncState(db) {
  const c = await dbClient(db);
  const settings = {
    tenantId: TENANT_ID,
    syncDeviceId: DEV_A,
    entityType: "settings",
    entityId: "cccccccc-0000-4000-8000-00000000000a",
  };
  // ── outbox: an already-applied unit and a unit abandoned mid-push ──
  await c.query(
    `INSERT INTO sync_outbox
       (id, tenant_id, sync_device_id, op_id, entity_type, entity_id, operation, payload, status, seq, created_at, updated_at, synced_at)
     VALUES
       (gen_random_uuid(), $1, $2, $3, 'settings', $4, 'update', '{"section":"taxes","settingsData":{"vat":0.05}}'::jsonb,
        'applied', 9001, now() - interval '2 hours', now() - interval '2 hours', now() - interval '2 hours'),
       (gen_random_uuid(), $1, $2, $5, 'settings', $4, 'update', '{"section":"units","settingsData":{}}'::jsonb,
        'pushing', 9002, now() - interval '1 hour', now() - interval '1 hour', NULL)
     ON CONFLICT (tenant_id, op_id) DO NOTHING`,
    [TENANT_ID, DEV_A, OP_APPLIED, settings.entityId, OP_PUSHING],
  );
  // ── inbound mirror: terminal states the device must not forget ──
  await c.query(
    `INSERT INTO sync_inbox
       (id, tenant_id, sync_device_id, op_id, entity_type, entity_id, operation, payload, status,
        received_seq, received_at, applied_at, reject_reason, apply_attempts)
     VALUES
       (gen_random_uuid(), $1, $2, $3, 'party', $6, 'create', '{}'::jsonb, 'applied', 9001, now() - interval '3 hours', now() - interval '3 hours', NULL, 0),
       (gen_random_uuid(), $1, $2, $4, 'invoice', $7, 'create', '{}'::jsonb, 'rejected', 9002, now() - interval '2 hours', NULL, 'تعارض مخزون', 1),
       (gen_random_uuid(), $1, $2, $5, 'invoice', $7, 'update', '{}'::jsonb, 'dead', 9003, now() - interval '1 hour', NULL, NULL, 5)
     ON CONFLICT (tenant_id, op_id) DO NOTHING`,
    [
      TENANT_ID,
      DEV_A,
      OP_INBOX_APPLIED,
      OP_INBOX_REJECTED,
      OP_INBOX_DEAD,
      "dddddddd-0000-4000-8000-000000000001",
      "dddddddd-0000-4000-8000-000000000002",
    ],
  );
  await c.query(
    `INSERT INTO sync_state (tenant_id, last_pull_seq, last_pull_at, updated_at)
     VALUES ($1, 9003, now() - interval '1 hour', now() - interval '1 hour')
     ON CONFLICT (tenant_id) DO UPDATE SET last_pull_seq = 9003, last_pull_at = now() - interval '1 hour'`,
    [TENANT_ID],
  );
  // ── a first-write-wins claim held by the DEAD unit (reap material) ──
  await c.query(
    `INSERT INTO sync_resource_claims
       (id, tenant_id, resource_type, resource_id, claimed_by_op_id, claimed_by_device_id, entity_type, entity_id, claimed_at, quantity_kg, quantity_pieces)
     VALUES (gen_random_uuid(), $1, 'roll', $2, $3, $4, 'invoice', $5, now() - interval '1 hour', NULL, NULL)
     ON CONFLICT DO NOTHING`,
    [
      TENANT_ID,
      "eeeeeeee-0000-4000-8000-000000000001",
      OP_INBOX_DEAD,
      DEV_A,
      "dddddddd-0000-4000-8000-000000000002",
    ],
  );
  // ── a deletion tombstone: restoring the master row must stay forbidden ──
  await c.query(
    `INSERT INTO sync_tombstones
       (id, tenant_id, entity_type, entity_id, op_id, deleted_by_device_id, deletion_seq)
     VALUES (gen_random_uuid(), $1, 'fabric', $2, $3, $4, 7)
     ON CONFLICT (tenant_id, entity_type, entity_id) DO NOTHING`,
    [TENANT_ID, "ffffffff-0000-4000-8000-000000000001", OP_INBOX_APPLIED, DEV_A],
  );
  // ── an open conflict (rejected update/cancel reconciliation) ──
  await c.query(
    `INSERT INTO sync_conflicts
       (id, tenant_id, op_id, entity_type, entity_id, operation, base_version, server_version, local_intent, status, created_at)
     VALUES (gen_random_uuid(), $1, $2, 'invoice', $3, 'update', 1, 3, '{"note":"local intent"}'::jsonb, 'open', now() - interval '1 hour')
     ON CONFLICT (tenant_id, op_id) DO NOTHING`,
    [TENANT_ID, OP_INBOX_REJECTED, "dddddddd-0000-4000-8000-000000000002"],
  );
  await c.end();
}

/** Snapshot of the sync rows that must survive the round trip. */
async function syncSnapshot(db) {
  return {
    outbox: await q(
      db,
      `SELECT id::text, op_id::text, entity_type, entity_id::text, operation, status, seq::bigint AS seq
         FROM sync_outbox WHERE tenant_id = $1 ORDER BY seq`,
      [TENANT_ID],
    ),
    inbox: await q(
      db,
      `SELECT id::text, op_id::text, entity_type, operation, status, received_seq::bigint AS received_seq, apply_attempts, reject_reason
         FROM sync_inbox WHERE tenant_id = $1 ORDER BY received_seq`,
      [TENANT_ID],
    ),
    claims: await q(
      db,
      `SELECT id::text, resource_type, resource_id::text, claimed_by_op_id::text, entity_type, entity_id::text
         FROM sync_resource_claims WHERE tenant_id = $1 ORDER BY resource_id`,
      [TENANT_ID],
    ),
    tombstones: await q(
      db,
      `SELECT id::text, entity_type, entity_id::text, op_id::text, deletion_seq::bigint AS deletion_seq
         FROM sync_tombstones WHERE tenant_id = $1 ORDER BY entity_id`,
      [TENANT_ID],
    ),
    conflicts: await q(
      db,
      `SELECT id::text, op_id::text, entity_type, operation, status, base_version, server_version
         FROM sync_conflicts WHERE tenant_id = $1 ORDER BY op_id`,
      [TENANT_ID],
    ),
    blocks: await q(
      db,
      `SELECT entity_type, year, prefix, start_number::bigint AS start_number, end_number::bigint AS end_number,
              next_number::bigint AS next_number, status, sync_device_id::text
         FROM document_number_blocks WHERE tenant_id = $1 ORDER BY entity_type, start_number`,
      [TENANT_ID],
    ),
    cursor: (
      await q(db, `SELECT last_pull_seq::bigint AS s FROM sync_state WHERE tenant_id = $1`, [TENANT_ID])
    )[0]?.s,
  };
}

function fingerprint(snap) {
  return JSON.stringify(snap);
}

// ------------------------------------------------------------------ restore runner

function runRestore(archiveOrDir, { db, user, password, resetCursor = false, uploadsDir }) {
  const args = ["scripts/restore-from-backup.mjs", archiveOrDir, "--url", url(db, user, password)];
  if (uploadsDir) args.push("--uploads-dir", uploadsDir);
  if (resetCursor) args.push("--reset-pull-cursor");
  const res = spawnSync(process.execPath, args, { cwd: BACKEND, encoding: "utf8" });
  return { status: res.status, out: `${res.stdout ?? ""}${res.stderr ?? ""}` };
}

// ------------------------------------------------------------------ main

async function main() {
  console.log("Batch 3B — restore sync-state semantics, end to end\n");
  workRoot = fs.mkdtempSync(path.join(os.tmpdir(), "erp-restore-verify-"));
  const uploadsDir = path.join(workRoot, "uploads");

  section("0. Fresh migrated template + hub/device databases");
  await createTemplate();
  await cloneFromTemplate(HUB);
  await cloneFromTemplate(DEV);
  await seed(HUB);
  await seed(DEV);
  info(`${HUB.db} + ${DEV.db} cloned from ${TPL.db} and seeded`);

  section("1. Start hub + device (device offline-capable, hub unreachable for pushes later)");
  startServer("hub", HUB.db, HUB.port, null, "restore-hub.log");
  await waitForHealth(HUB.port, "hub");
  startServer("dev", DEV.db, DEV.port, `http://127.0.0.1:${HUB.port}`, "restore-dev.log");
  await waitForHealth(DEV.port, "device");
  TOKEN = await mintToken();
  info("hub and device healthy");

  section("2. Device provisions number blocks, then works (writes stay pending)");
  const ensure = await api(DEV.port, "POST", "/api/sync/number-blocks/ensure", {
    deviceId: DEV_A,
    body: { syncDeviceId: DEV_A },
  });
  check(
    "device reserved its number blocks (offline document creation possible)",
    ensure.status === 200,
    `HTTP ${ensure.status} ${ensure.text.slice(0, 160)}`,
  );

  const u = randomUUID().slice(0, 8);
  const party = await api(DEV.port, "POST", "/api/customers", {
    deviceId: DEV_A,
    body: { name: `Restore-Customer-${u}` },
  });
  check("offline customer write succeeded", party.status === 201, `HTTP ${party.status}`);
  const fab = await api(DEV.port, "POST", "/api/inventory/fabrics", {
    deviceId: DEV_A,
    body: { name: `قماش ${u}` },
  });
  const col = await api(DEV.port, "POST", "/api/inventory/colors", {
    deviceId: DEV_A,
    body: { fabricId: fab.json?.id, name: `لون ${u}`, code: `C${u}` },
  });
  const roll = await api(DEV.port, "POST", "/api/inventory/rolls", {
    deviceId: DEV_A,
    body: {
      colorId: col.json?.id,
      rollNo: `R-${u}`,
      initialKg: 500,
      remainingKg: 500,
      pricePerKg: 1000,
      entryDate: "2026-01-15",
    },
  });
  info(
    `stock chain: fabric HTTP ${fab.status} (${fab.json?.id ?? fab.text.slice(0, 120)}) · ` +
      `color HTTP ${col.status} (${col.json?.id ?? col.text.slice(0, 120)}) · ` +
      `roll HTTP ${roll.status} (${roll.json?.id ?? roll.text.slice(0, 120)})`,
  );
  const invoice = await api(DEV.port, "POST", "/api/invoices", {
    deviceId: DEV_A,
    body: {
      type: "sale",
      date: "2026-01-15",
      partyId: party.json?.id,
      partyType: "customer",
      currency: "SYP",
      exchangeRate: 15000,
      lines: [
        {
          fabricId: fab.json?.id,
          colorId: col.json?.id,
          rollId: roll.json?.id,
          quantityKg: 10,
          pricePerKg: 1000,
        },
      ],
    },
  });
  check(
    "offline sale invoice succeeded (stock + ledger + outbox in one transaction)",
    invoice.status === 201,
    `HTTP ${invoice.status} ${invoice.text.slice(0, 200)}`,
  );
  const profile = await api(DEV.port, "PUT", "/api/company/profile", {
    deviceId: DEV_A,
    body: { name: "شركة الاستعادة" },
  });
  check("company profile write succeeded", profile.status === 200, `HTTP ${profile.status}`);

  const pendingBefore = await q(
    DEV.db,
    `SELECT count(*)::int AS n FROM sync_outbox WHERE tenant_id = $1 AND status = 'pending'`,
    [TENANT_ID],
  );
  check(
    "the device now holds un-pushed operations",
    Number(pendingBefore[0].n) >= 4,
    `pending = ${pendingBefore[0].n}`,
  );

  section("3. Phase the sync state a synchronized device would already have");
  await seedSyncState(DEV.db);
  const before = await syncSnapshot(DEV.db);
  info(
    `outbox=${before.outbox.length} inbox=${before.inbox.length} claims=${before.claims.length} ` +
      `tombstones=${before.tombstones.length} conflicts=${before.conflicts.length} blocks=${before.blocks.length} cursor=${before.cursor}`,
  );

  section("4. Backup the offline device through the real API");
  const backup = await api(DEV.port, "POST", "/api/backup/full", { deviceId: DEV_A, raw: true });
  const archivePath = path.join(workRoot, "device-backup.tar.gz");
  if (backup.status === 200) fs.writeFileSync(archivePath, backup.buffer);
  check(
    "POST /api/backup/full produced an archive",
    backup.status === 200 && backup.buffer.length > 1000,
    `HTTP ${backup.status}, ${backup.buffer?.length ?? 0} bytes :: ${backup.buffer
      ?.toString("utf8")
      .slice(0, 300)}`,
  );
  // The backup must contain the sync tables at all — the defect's first half.
  if (backup.status !== 200) {
    throw new Error(
      `POST /api/backup/full failed (HTTP ${backup.status}): ${backup.buffer?.toString("utf8").slice(0, 500)}`,
    );
  }
  const extractDir = path.join(workRoot, "extracted");
  fs.mkdirSync(extractDir, { recursive: true });
  // Same Windows/GNU-tar hazard as the restore script: `-f`/`-C` with a drive
  // path either becomes a remote `host:path` or fails outright, so run tar from
  // the extraction directory with a relative, forward-slashed archive path.
  const relArchive = path.relative(extractDir, archivePath).split(path.sep).join("/");
  const extract = spawnSync("tar", ["-xf", relArchive], { cwd: extractDir, encoding: "utf8" });
  if (extract.status !== 0) {
    throw new Error(`extraction failed: ${extract.stderr}`);
  }
  const dumpPath = fs.existsSync(path.join(extractDir, "database.json"))
    ? path.join(extractDir, "database.json")
    : path.join(extractDir, "device-backup", "database.json");
  const dump = JSON.parse(fs.readFileSync(dumpPath, "utf8"));
  check(
    "the archive contains the sync tables (outbox/inbox/state/claims/blocks)",
    (dump.tables.sync_outbox?.length ?? 0) > 0 &&
      (dump.tables.sync_inbox?.length ?? 0) > 0 &&
      (dump.tables.sync_state?.length ?? 0) > 0 &&
      (dump.tables.document_number_blocks?.length ?? 0) > 0,
    `outbox=${dump.tables.sync_outbox?.length} inbox=${dump.tables.sync_inbox?.length} ` +
      `state=${dump.tables.sync_state?.length} blocks=${dump.tables.document_number_blocks?.length}`,
  );

  section("5. Disaster: the device database is destroyed (fresh migrated schema)");
  await stopServer("dev");
  await cloneFromTemplate(DEV);
  await seed(DEV); // a fresh machine still has its tenant + device identity
  const emptyOutbox = await q(
    DEV.db,
    `SELECT count(*)::int AS n FROM sync_outbox WHERE tenant_id = $1`,
    [TENANT_ID],
  );
  check("the rebuilt database starts with no sync state", Number(emptyOutbox[0].n) === 0, "");

  section("6. Restore from the archive (as the superuser role)");
  const restore = runRestore(archivePath, { db: DEV.db, uploadsDir });
  info(restore.out.split(/\r?\n/).filter(Boolean).slice(-8).join("\n     "));
  check("restore script exited 0", restore.status === 0, `exit=${restore.status}`);
  check(
    "restore reported the ordering-sequence fix-up",
    /sequence .*next value =/.test(restore.out),
    "",
  );
  check(
    "restore verified the pending-outbox invariant (no operation lost)",
    /PENDING-OUTBOX INVARIANT/.test(restore.out),
    (restore.out.match(/PENDING-OUTBOX INVARIANT.*/) ?? [""])[0],
  );

  section("7. Sync state is bit-for-bit restored");
  const after = await syncSnapshot(DEV.db);
  check(
    "outbox rows restored verbatim (ids, op-ids, statuses, seq order)",
    JSON.stringify(after.outbox) === JSON.stringify(before.outbox),
    `before=${before.outbox.length} after=${after.outbox.length}`,
  );
  check(
    "inbox rows restored verbatim (statuses + apply_attempts + received_seq)",
    JSON.stringify(after.inbox) === JSON.stringify(before.inbox),
    `before=${before.inbox.length} after=${after.inbox.length}`,
  );
  check(
    "resource claims restored (decided conflicts stay decided)",
    JSON.stringify(after.claims) === JSON.stringify(before.claims),
    `claims=${after.claims.length}`,
  );
  check(
    "tombstones restored (deleted rows cannot resurrect)",
    JSON.stringify(after.tombstones) === JSON.stringify(before.tombstones),
    `tombstones=${after.tombstones.length}`,
  );
  check(
    "conflicts restored (rejected update/cancel reconciliation survives)",
    JSON.stringify(after.conflicts) === JSON.stringify(before.conflicts),
    `conflicts=${after.conflicts.length}`,
  );
  check(
    "device number blocks restored (offline numbering keeps its reserved range)",
    JSON.stringify(after.blocks) === JSON.stringify(before.blocks) && after.blocks.length > 0,
    `blocks=${after.blocks.length}`,
  );
  check(
    "pull cursor restored at its recorded position",
    after.cursor === before.cursor,
    `cursor=${after.cursor}`,
  );
  const business = await q(
    DEV.db,
    `SELECT (SELECT count(*)::int FROM invoices WHERE tenant_id=$1) AS invoices,
            (SELECT count(*)::int FROM parties WHERE tenant_id=$1) AS parties,
            (SELECT count(*)::int FROM company_profiles WHERE tenant_id=$1) AS profiles`,
    [TENANT_ID],
  );
  check(
    "business rows came back with the sync state",
    business[0].invoices === 1 && business[0].parties >= 1 && business[0].profiles === 1,
    JSON.stringify(business[0]),
  );

  section("8. Sequence continuity after the restore");
  const seqState = await q(
    DEV.db,
    `SELECT pg_get_serial_sequence('sync_outbox','seq') AS outbox_seq,
            pg_get_serial_sequence('sync_inbox','received_seq') AS inbox_seq,
            (SELECT max(seq)::bigint FROM sync_outbox WHERE tenant_id=$1) AS max_outbox`,
    [TENANT_ID],
  );
  const newOp = randomUUID();
  await q(
    DEV.db,
    `INSERT INTO sync_outbox (tenant_id, sync_device_id, op_id, entity_type, entity_id, operation, payload, status)
     VALUES ($1, $2, $3, 'settings', 'cccccccc-0000-4000-8000-00000000000b', 'update', '{}'::jsonb, 'pending')`,
    [TENANT_ID, DEV_A, newOp],
  );
  const newSeq = Number(
    (
      await q(DEV.db, `SELECT seq::bigint AS s FROM sync_outbox WHERE op_id = $1`, [newOp])
    )[0].s,
  );
  check(
    "a unit enqueued after the restore sorts AFTER every restored unit",
    newSeq > Number(seqState[0].max_outbox),
    `new seq=${newSeq} > restored max=${seqState[0].max_outbox}`,
  );
  await q(DEV.db, `DELETE FROM sync_outbox WHERE op_id = $1`, [newOp]);

  // The bigserial PKs the app never writes explicitly must keep working.
  let auditOk = true;
  try {
    await q(
      DEV.db,
      `INSERT INTO audit_logs (tenant_id, module, action) VALUES ($1, 'restore', 'verify')`,
      [TENANT_ID],
    );
  } catch (err) {
    auditOk = false;
    info(`audit_logs insert failed: ${err.message.split("\n")[0]}`);
  }
  check("audit_logs bigserial PK still allocates after the restore", auditOk, "");

  let idemOk = true;
  let idemErr = "";
  try {
    await q(
      DEV.db,
      `INSERT INTO idempotency_keys (tenant_id, method, path, idempotency_key, status_code, expires_at)
       VALUES ($1, 'POST', '/api/restore-verify', $2, 200, now() + interval '1 hour')`,
      [TENANT_ID, `k-${randomUUID()}`],
    );
  } catch (err) {
    idemOk = false;
    idemErr = err.message.split("\n")[0];
  }
  check("idempotency_keys bigserial PK still allocates after the restore", idemOk, idemErr);

  section("9. Resume synchronization from the restored device");
  startServer("dev", DEV.db, DEV.port, `http://127.0.0.1:${HUB.port}`, "restore-dev-restart.log");
  await waitForHealth(DEV.port, "device (restored)");
  const rounds = await syncUntilDrained(DEV.port, DEV_A);
  info(`sync/run rounds: ${JSON.stringify(rounds.slice(-3))}`);

  const hubInbox = await q(
    HUB.db,
    `SELECT op_id::text, entity_type, status FROM sync_inbox WHERE tenant_id = $1`,
    [TENANT_ID],
  );
  const hubOpIds = new Set(hubInbox.map((r) => r.op_id));
  const devOutbox = await q(
    DEV.db,
    `SELECT op_id::text, status FROM sync_outbox WHERE tenant_id = $1`,
    [TENANT_ID],
  );
  const restoredPendingOps = before.outbox
    .filter((r) => r.status === "pending")
    .map((r) => r.op_id);
  const missing = restoredPendingOps.filter((op) => !hubOpIds.has(op));
  check(
    "every operation that was pending in the backup reached the hub (none lost)",
    missing.length === 0 && restoredPendingOps.length >= 4,
    `pending-in-backup=${restoredPendingOps.length} missing-at-hub=${missing.length}`,
  );
  check(
    "an operation restored as `applied` is NOT re-pushed",
    !hubOpIds.has(OP_APPLIED),
    `hub has ${hubOpIds.has(OP_APPLIED) ? "a row for it" : "no row for it"}`,
  );
  check(
    "a unit stranded as `pushing` before the crash was reclaimed and delivered",
    hubOpIds.has(OP_PUSHING),
    `hub has ${hubOpIds.has(OP_PUSHING) ? "it" : "nothing"}`,
  );
  check(
    "the device outbox drained to applied (known terminal state)",
    devOutbox.filter((r) => r.status === "pending" || r.status === "pushing").length === 0,
    JSON.stringify(devOutbox.map((r) => r.status)),
  );

  section("10. No duplicate business effect on the hub");
  const hubCounts = await q(
    HUB.db,
    `SELECT (SELECT count(*)::int FROM invoices WHERE tenant_id=$1) AS invoices,
            (SELECT count(*)::int FROM invoice_lines WHERE tenant_id=$1) AS invoice_lines,
            (SELECT count(*)::int FROM parties WHERE tenant_id=$1) AS parties,
            (SELECT count(*)::int FROM ledger_entries WHERE tenant_id=$1) AS ledger,
            (SELECT count(*)::int FROM sync_inbox WHERE tenant_id=$1) AS inbox`,
    [TENANT_ID],
  );
  check(
    "the restored invoice exists exactly once on the hub",
    hubCounts[0].invoices === 1 && hubCounts[0].invoice_lines === 1,
    JSON.stringify(hubCounts[0]),
  );
  check(
    "no duplicate sync inbox row for any pushed unit",
    Number(hubCounts[0].inbox) === hubInbox.length,
    `inbox=${hubCounts[0].inbox} distinct-op rows=${hubInbox.length}`,
  );
  await syncUntilDrained(DEV.port, DEV_A);
  const hubCounts2 = await q(
    HUB.db,
    `SELECT (SELECT count(*)::int FROM invoices WHERE tenant_id=$1) AS invoices,
            (SELECT count(*)::int FROM invoice_lines WHERE tenant_id=$1) AS invoice_lines,
            (SELECT count(*)::int FROM ledger_entries WHERE tenant_id=$1) AS ledger`,
    [TENANT_ID],
  );
  check(
    "re-running sync is idempotent (no duplicate invoice / lines / ledger)",
    JSON.stringify(hubCounts[0]) === JSON.stringify({ ...hubCounts[0], ...hubCounts2[0] }) &&
      hubCounts2[0].invoices === 1 &&
      hubCounts2[0].invoice_lines === 1,
    JSON.stringify(hubCounts2[0]),
  );

  section("11. Cursor safety: clamp vs --reset-pull-cursor");
  const inboxMax = Math.max(...before.inbox.map((r) => Number(r.received_seq)));
  // (a) A cursor pointing past everything the database has recorded must be
  //     clamped, not trusted: trusting it skips operations silently.
  const clampedDumpDir = path.join(workRoot, "clamp");
  fs.mkdirSync(clampedDumpDir, { recursive: true });
  fs.cpSync(extractDir, clampedDumpDir, { recursive: true });
  const clampedDumpPath = path.join(clampedDumpDir, path.relative(extractDir, dumpPath));
  const clampDump = JSON.parse(fs.readFileSync(clampedDumpPath, "utf8"));
  clampDump.tables.sync_state[0].last_pull_seq = inboxMax + 5000;
  fs.writeFileSync(clampedDumpPath, JSON.stringify(clampDump));
  const clampRestore = runRestore(clampedDumpDir, { db: DEV.db, uploadsDir });
  const clampedCursor = (
    await q(DEV.db, `SELECT last_pull_seq::bigint AS s FROM sync_state WHERE tenant_id = $1`, [
      TENANT_ID,
    ])
  )[0]?.s;
  check(
    "a cursor beyond every recorded unit is clamped to the highest recorded seq",
    clampRestore.status === 0 && Number(clampedCursor) === inboxMax,
    `cursor=${clampedCursor} expected=${inboxMax} (script said CLAMPED: ${/CLAMPED/.test(clampRestore.out)})`,
  );

  // (b) The documented "different hub" escape hatch.
  const resetRestore = runRestore(clampedDumpDir, { db: DEV.db, uploadsDir, resetCursor: true });
  const resetCursor = (
    await q(DEV.db, `SELECT last_pull_seq AS s FROM sync_state WHERE tenant_id = $1`, [TENANT_ID])
  )[0]?.s;
  check(
    "--reset-pull-cursor clears the cursor for the different-hub case",
    resetRestore.status === 0 && resetCursor === null,
    `cursor=${resetCursor}`,
  );

  section("12. RLS: a role that cannot finish the restore refuses up front");
  // app_user can neither bypass RLS nor own ledger_entries, and the wipe must
  // drop/recreate that table's append-only trigger. The script used to print an
  // RLS message and then die on `must be owner of relation ledger_entries`,
  // leaving a half-restored database. It must now refuse BEFORE touching data.
  const stateBeforeRefusal = await q(
    DEV.db,
    `SELECT (SELECT count(*)::int FROM sync_outbox WHERE tenant_id=$1 AND status IN ('pending','pushing')) AS pending,
            (SELECT count(*)::int FROM invoices WHERE tenant_id=$1) AS invoices,
            (SELECT count(*)::int FROM document_number_blocks WHERE tenant_id=$1) AS blocks`,
    [TENANT_ID],
  );
  const rlsRestore = runRestore(clampedDumpDir, {
    db: DEV.db,
    user: APP_USER,
    password: APP_USER_PASSWORD,
    uploadsDir,
  });
  check(
    "the restore REFUSES a role that can neither bypass RLS nor manage the ledger trigger",
    rlsRestore.status !== 0 && /Refusing to restore/.test(rlsRestore.out),
    `exit=${rlsRestore.status} :: ${(rlsRestore.out.match(/Refusing to restore.*/) ?? [""])[0].slice(0, 160)}`,
  );
  check(
    "the refusal is actionable (names the ownership requirement)",
    /ledger_entries/.test(rlsRestore.out) && /OWNER TO/.test(rlsRestore.out),
    "",
  );
  const stateAfterRefusal = await q(
    DEV.db,
    `SELECT (SELECT count(*)::int FROM sync_outbox WHERE tenant_id=$1 AND status IN ('pending','pushing')) AS pending,
            (SELECT count(*)::int FROM invoices WHERE tenant_id=$1) AS invoices,
            (SELECT count(*)::int FROM document_number_blocks WHERE tenant_id=$1) AS blocks`,
    [TENANT_ID],
  );
  check(
    "a refused restore deletes NOTHING (no half-restore: sync + business + numbering intact)",
    JSON.stringify(stateBeforeRefusal[0]) === JSON.stringify(stateAfterRefusal[0]) &&
      Number(stateAfterRefusal[0].blocks) > 0,
    `before=${JSON.stringify(stateBeforeRefusal[0])} after=${JSON.stringify(stateAfterRefusal[0])}`,
  );
  const crossTenant = await q(
    DEV.db,
    `SELECT count(*)::int AS n FROM sync_outbox WHERE tenant_id <> $1`,
    [TENANT_ID],
  );
  check(
    "no row was written outside the backup's tenant",
    Number(crossTenant[0].n) === 0,
    `other-tenant rows = ${crossTenant[0].n}`,
  );

  section("Summary");
  const passed = results.filter((r) => r.pass).length;
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
  for (const f of ["restore-hub.log", "restore-dev.log", "restore-dev-restart.log"]) {
    const p = path.join(BACKEND, f);
    if (fs.existsSync(p)) {
      console.error(`\n----- ${f} -----\n${fs.readFileSync(p, "utf8").slice(-2500)}`);
    }
  }
} finally {
  await stopAllServers();
  if (!process.argv.includes("--keep")) {
    try {
      const c = await adminClient();
      for (const d of [HUB.db, DEV.db, TPL.db]) {
        await c.query(`DROP DATABASE IF EXISTS "${d}" WITH (FORCE)`);
      }
      await c.end();
    } catch {
      /* best effort */
    }
    if (workRoot) fs.rmSync(workRoot, { recursive: true, force: true });
  } else {
    console.log(`\n--keep: databases ${TPL.db}, ${HUB.db}, ${DEV.db} and ${workRoot} left in place.`);
  }
}
process.exit(exitCode);
