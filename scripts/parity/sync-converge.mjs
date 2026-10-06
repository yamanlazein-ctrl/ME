#!/usr/bin/env node
/**
 * US5 / AC-8 convergence (specs/001-desktop-sqlite-engine T102, quickstart §6; SC-007).
 *
 * Topology — three real backend processes, nothing mocked:
 *   hub      PostgreSQL (the unchanged cloud hub)            :8191
 *   device A DB_ENGINE=<engine>, CENTRAL_SYNC_URL → hub      :8192
 *   device B DB_ENGINE=<engine>, CENTRAL_SYNC_URL → hub      :8193
 *
 * Scenario:
 *   online   A creates customer C1 and a 100 kg roll R; A and B reserve number blocks; A pushes,
 *            B pulls → both know C1 and R.
 *   offline  A: 20 sale invoices (one takes 2 kg of the SHARED roll R), B: 30 sale invoices (one
 *            takes 3 kg of R), both edit C1's phone (same-record edit), each pays cash on some.
 *   sync     A, B, A until drained.
 *   assert   A, B and the hub show the same invoices (numbers, totals, paid), parties (codes,
 *            phones), party balances, C1 statement + ledger, rolls (remaining kg) and cash box.
 *
 * With --out <dir> it also writes the canonical final state and the wire capture (hub inbox = what
 * the devices pushed; device inboxes = what they pulled) for scripts/parity/sync-wire.mjs.
 *
 *   node scripts/parity/sync-converge.mjs --device-engine sqlite|postgres [--out dir] [--keep]
 */
import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { randomUUID } from "node:crypto";

const here = dirname(fileURLToPath(import.meta.url));
const BACKEND = resolve(here, "../../backend");
const req = createRequire(join(BACKEND, "package.json"));
const pg = req("pg");
const Database = req("better-sqlite3");
const { SignJWT } = req("jose");

const args = process.argv.slice(2);
const opt = (k, d) => (args.includes(`--${k}`) ? args[args.indexOf(`--${k}`) + 1] : d);
const ENGINE = opt("device-engine", "sqlite");
const OUT = opt("out", null);
const KEEP = args.includes("--keep");
if (!["sqlite", "postgres"].includes(ENGINE)) throw new Error("--device-engine sqlite|postgres");

const TENANT_ID = "11111111-1111-4111-8111-111111111111";
const USER_ID = "22222222-2222-4222-8222-222222222222";
const DEV_A = "33333333-3333-4333-8333-333333333333";
const DEV_B = "44444444-4444-4444-8444-444444444444";
const PORTS = { hub: 8191, A: 8192, B: 8193 };
const JWT = { hub: "hub-sync-jwt-secret-key-min-32-chars!!", A: "device-a-offline-sync-jwt-secret-key!!", B: "device-b-offline-sync-jwt-secret-key!!" };
const APP_MASTER_KEY = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=";
const TEMPLATE = "parity_sync_tpl";
const RUN = `${Date.now()}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── PostgreSQL (the 55432 test cluster; URL from backend/.env.test, never printed) ──────────────
function pgAdminUrl() {
  if (process.env.PARITY_PG_URL) return process.env.PARITY_PG_URL;
  const line = readFileSync(join(BACKEND, ".env.test"), "utf8").split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
  const u = new URL(line.slice("DATABASE_URL=".length).trim().replace(/^["']|["']$/g, ""));
  u.port = process.env.PARITY_PG_PORT ?? "55432";
  u.pathname = "/postgres";
  return u.toString();
}
const ADMIN = pgAdminUrl();
const dbUrl = (db) => {
  const u = new URL(ADMIN);
  u.pathname = `/${db}`;
  return u.toString();
};
async function admin(sql) {
  const c = new pg.Client({ connectionString: ADMIN });
  await c.connect();
  try {
    return await c.query(sql);
  } finally {
    await c.end();
  }
}
async function onPg(db, fn) {
  const c = new pg.Client({ connectionString: dbUrl(db) });
  await c.connect();
  try {
    return await fn(c);
  } finally {
    await c.end();
  }
}

async function ensureTemplate() {
  const exists = (await admin(`SELECT 1 FROM pg_database WHERE datname = '${TEMPLATE}'`)).rows.length > 0;
  if (exists) {
    const ok = await onPg(TEMPLATE, async (c) =>
      (await c.query(`SELECT count(*)::int AS n FROM information_schema.columns WHERE table_name='sync_inbox' AND column_name='applied_seq'`)).rows[0].n === 1,
    ).catch(() => false);
    if (ok) return;
    await admin(`DROP DATABASE IF EXISTS ${TEMPLATE} WITH (FORCE)`);
  }
  await admin(`CREATE DATABASE ${TEMPLATE} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`);
  console.log("  migrating the PostgreSQL template (once, ~2 min)…");
  execFileSync(process.execPath, ["node_modules/drizzle-kit/bin.cjs", "migrate"], {
    cwd: BACKEND,
    env: { ...process.env, DATABASE_URL: dbUrl(TEMPLATE), NODE_ENV: "test" },
    stdio: ["ignore", "ignore", "inherit"],
  });
}

const SEED_PG = [
  [`INSERT INTO tenants (id, name, slug, status, license_status, license_type) VALUES ($1, 'Sync Parity Co', $2, 'active', 'no_license', 'trial') ON CONFLICT (id) DO NOTHING`, (n) => [TENANT_ID, `sync-parity-${n}`]],
  [`INSERT INTO users (id, tenant_id, name, email, password_hash, role, active) VALUES ($1, $2, 'Sync Admin', $3, 'tokens-are-minted', 'admin', true) ON CONFLICT (id) DO NOTHING`, (n) => [USER_ID, TENANT_ID, `admin-${n}@sync.local`]],
  ...[DEV_A, DEV_B].flatMap((d, i) => [
    [`INSERT INTO sync_devices (id, tenant_id, device_fingerprint, platform, hostname, label, last_seen_by_user_id, authorized_user_ids) VALUES ($1, $2, $3, 'windows', $4, $4, $5, ARRAY[$5]::uuid[]) ON CONFLICT (id) DO NOTHING`, (n) => [d, TENANT_ID, `fp-${i}-${n}`, `device-${"ab"[i]}`, USER_ID]],
    [`INSERT INTO sync_device_authorized_users (tenant_id, device_id, user_id) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, () => [TENANT_ID, d, USER_ID]],
  ]),
  [`INSERT INTO setup_wizard_state (tenant_id, current_step, completed_steps, is_completed, completed_at) VALUES ($1, 'done', ARRAY['welcome'], true, now()) ON CONFLICT (tenant_id) DO UPDATE SET is_completed = true, current_step = 'done'`, () => [TENANT_ID]],
];

/** The same rows on SQLite (arrays are JSON text, booleans 0/1, timestamps ISO). */
function seedSqlite(path, n) {
  const db = new Database(path);
  const now = new Date().toISOString().replace("Z", "000Z");
  try {
    db.prepare(`INSERT OR IGNORE INTO tenants (id, name, slug, status, license_status, license_type) VALUES (?, 'Sync Parity Co', ?, 'active', 'no_license', 'trial')`).run(TENANT_ID, `sync-parity-${n}`);
    db.prepare(`INSERT OR IGNORE INTO users (id, tenant_id, name, email, password_hash, role, active) VALUES (?, ?, 'Sync Admin', ?, 'tokens-are-minted', 'admin', 1)`).run(USER_ID, TENANT_ID, `admin-${n}@sync.local`);
    [DEV_A, DEV_B].forEach((d, i) => {
      db.prepare(`INSERT OR IGNORE INTO sync_devices (id, tenant_id, device_fingerprint, platform, hostname, label, last_seen_by_user_id, authorized_user_ids) VALUES (?, ?, ?, 'windows', ?, ?, ?, ?)`).run(d, TENANT_ID, `fp-${i}-${n}`, `device-${"ab"[i]}`, `device-${"ab"[i]}`, USER_ID, JSON.stringify([USER_ID]));
      db.prepare(`INSERT OR IGNORE INTO sync_device_authorized_users (tenant_id, device_id, user_id) VALUES (?, ?, ?)`).run(TENANT_ID, d, USER_ID);
    });
    db.prepare(`INSERT INTO setup_wizard_state (tenant_id, current_step, completed_steps, is_completed, completed_at) VALUES (?, 'done', '["welcome"]', 1, ?) ON CONFLICT (tenant_id) DO UPDATE SET is_completed = 1, current_step = 'done'`).run(TENANT_ID, now);
  } finally {
    db.close();
  }
}

// ── processes ─────────────────────────────────────────────────────────────────────────────────
const procs = [];
function baseEnv(port, secret) {
  const env = {
    ...process.env,
    NODE_ENV: "test",
    PORT: String(port),
    HOST: "127.0.0.1",
    LOG_LEVEL: "warn",
    RATE_LIMIT_RPS: "100000",
    RATE_LIMIT_WINDOW_MS: "60000",
    CORS_ORIGIN: "http://localhost:5173",
    JWT_SECRET: secret,
    APP_MASTER_KEY,
    LICENSE_SERVER_MODE: "embedded",
    BACKUP_MIRROR_DIR: "off",
  };
  for (const k of ["DATABASE_URL", "TEST_DB_URL", "DESKTOP_DEPLOY", "CENTRAL_SYNC_URL", "HUB_SYNC_ACCESS_TOKEN", "DB_ENGINE", "SQLITE_PATH", "MOTARD_STARTUP_STATE"]) delete env[k];
  return env;
}
async function start(name, env) {
  const p = spawn(process.execPath, [join(BACKEND, "node_modules/tsx/dist/cli.mjs"), "src/presentation/server.ts"], { cwd: BACKEND, env, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  p.stdout.on("data", (d) => (log += d));
  p.stderr.on("data", (d) => (log += d));
  p.__name = name;
  procs.push(p);
  const until = Date.now() + 180_000;
  while (Date.now() < until) {
    if (p.exitCode !== null) throw new Error(`${name} exited ${p.exitCode}\n${log.slice(-3000)}`);
    try {
      if ((await fetch(`http://127.0.0.1:${env.PORT}/api/health/live`)).ok) return p;
    } catch {
      /* not yet */
    }
    await sleep(400);
  }
  throw new Error(`${name} not healthy\n${log.slice(-3000)}`);
}
function kill(p) {
  try {
    if (process.platform === "win32") execFileSync("taskkill", ["/pid", String(p.pid), "/T", "/F"], { stdio: "ignore" });
    else p.kill("SIGKILL");
  } catch {
    /* gone */
  }
}

const mint = (secret) =>
  new SignJWT({ sub: USER_ID, tenantId: TENANT_ID, role: "admin", jti: randomUUID(), type: "access" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 7200)
    .sign(new TextEncoder().encode(secret));
const tokens = {};
async function api(node, method, path, body, { deviceId, idem } = {}) {
  const r = await fetch(`http://127.0.0.1:${PORTS[node]}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${tokens[node]}`,
      "Content-Type": "application/json",
      ...(deviceId ? { "X-Sync-Device-Id": deviceId } : {}),
      ...(method !== "GET" ? { "Idempotency-Key": idem ?? randomUUID() } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    /* text */
  }
  return { status: r.status, json, text };
}
const must = async (label, p) => {
  const r = await p;
  if (r.status >= 400) throw new Error(`${label}: HTTP ${r.status} ${r.text.slice(0, 400)}`);
  return r.json;
};
async function syncUntilDrained(node, max = 8) {
  for (let i = 0; i < max; i++) {
    const r = await api(node, "POST", "/api/sync/run");
    if (r.status !== 200) throw new Error(`${node} /sync/run HTTP ${r.status} ${r.text.slice(0, 300)}`);
    const j = r.json;
    if (!(j.pushed ?? 0) && !(j.failed ?? 0) && !(j.rejected ?? 0) && !(j.pull?.pulled ?? 0)) return;
  }
}

// ── state, read through the API (what a user sees) ────────────────────────────────────────────
const DROP = /^(createdAt|updatedAt|syncedAt|deletedAt|version|lastSeenAt|cancelledAt|_links)$/;
function strip(v) {
  if (Array.isArray(v)) return v.map(strip);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).filter(([k]) => !DROP.test(k)).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, x]) => [k, strip(x)]));
  return v;
}
const items = (j) => (Array.isArray(j) ? j : j?.items ?? j?.data ?? j?.rows ?? j);
/**
 * Rows each node DERIVES while materializing a synced document (invoice lines, ledger entries) carry
 * node-local surrogate ids, and same-date ledger ties follow each node's own insertion order — the
 * existing PostgreSQL sync behaves exactly so (reference run with PostgreSQL devices). They are
 * compared by content: line ids masked; ledger entries without id/seq/runningBalance, as a sorted set.
 */
function derivedLines(invoices) {
  return invoices.map((inv) => (Array.isArray(inv.lines) ? { ...inv, lines: inv.lines.map(({ id, ...rest }) => rest).sort((x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1)) } : inv));
}
function ledgerSet(entries) {
  const list = Array.isArray(entries) ? entries : entries?.entries ?? entries?.items ?? entries;
  if (!Array.isArray(list)) return list;
  return list.map(({ id, seq, runningBalance, ...rest }) => rest).sort((x, y) => (JSON.stringify(x) < JSON.stringify(y) ? -1 : 1));
}
async function stateOf(node, c1, date) {
  const get = async (p) => strip(items(await must(`${node} GET ${p}`, api(node, "GET", p))));
  const byKey = (k) => (a, b) => (String(a[k]) < String(b[k]) ? -1 : 1);
  return {
    invoices: derivedLines((await get("/api/invoices?type=sale&limit=500")).sort(byKey("number"))),
    customers: (await get("/api/customers?limit=500")).sort(byKey("name")),
    partyBalances: await get("/api/reports/party-balances"),
    c1Statement: await get(`/api/customers/${c1}/statement`),
    c1Ledger: ledgerSet(await get(`/api/ledger/party/${c1}`)),
    rolls: (await get("/api/inventory/rolls?limit=500")).sort(byKey("rollNo")),
    cashbox: await get(`/api/cashbox/balance/${date}`),
  };
}

// ── wire capture ──────────────────────────────────────────────────────────────────────────────
async function inboxOf(node, handle) {
  const sql = `SELECT op_id, sync_device_id, entity_type, entity_id, operation, payload, status FROM sync_inbox WHERE tenant_id = '${TENANT_ID}' ORDER BY received_seq`;
  if (handle.kind === "pg") return onPg(handle.db, async (c) => (await c.query(sql)).rows);
  const db = new Database(handle.path, { readonly: true });
  try {
    return db.prepare(sql).all().map((r) => ({ ...r, payload: JSON.parse(r.payload) }));
  } finally {
    db.close();
  }
}

// ── main ──────────────────────────────────────────────────────────────────────────────────────
const checks = [];
const check = (name, ok, detail) => {
  checks.push({ name, pass: !!ok, detail });
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${name}${detail && !ok ? ` — ${typeof detail === "string" ? detail : JSON.stringify(detail).slice(0, 600)}` : ""}`);
};
const work = mkdtempSync(join(tmpdir(), `motard-sync-${ENGINE}-`));
const handles = {};
const created = [];

async function main() {
  console.log(`US5 convergence — devices on ${ENGINE}, hub on PostgreSQL`);
  await ensureTemplate();
  for (const node of ["hub", ...(ENGINE === "postgres" ? ["A", "B"] : [])]) {
    const db = `parity_sync_${node.toLowerCase()}_${RUN}`;
    await admin(`CREATE DATABASE ${db} TEMPLATE ${TEMPLATE}`);
    created.push(db);
    await onPg(db, async (c) => {
      for (const [sql, params] of SEED_PG) await c.query(sql, params(`${node}-${RUN}`));
    });
    handles[node] = { kind: "pg", db };
  }
  for (const node of ["hub", "A", "B"]) tokens[node] = await mint(JWT[node]);

  await start("hub", { ...baseEnv(PORTS.hub, JWT.hub), DATABASE_URL: dbUrl(handles.hub.db) });
  for (const node of ["A", "B"]) {
    const env = { ...baseEnv(PORTS[node], JWT[node]), CENTRAL_SYNC_URL: `http://127.0.0.1:${PORTS.hub}`, HUB_SYNC_ACCESS_TOKEN: tokens.hub };
    if (ENGINE === "postgres") {
      await start(node, { ...env, DATABASE_URL: dbUrl(handles[node].db) });
    } else {
      const path = join(work, node, "data", "motard.db");
      mkdirSync(dirname(path), { recursive: true });
      const sq = { ...env, DB_ENGINE: "sqlite", SQLITE_PATH: path };
      kill(await start(`${node}-create`, { ...sq, MOTARD_STARTUP_STATE: "FRESH" })); // creates + migrates
      await sleep(800);
      seedSqlite(path, `${node}-${RUN}`);
      await start(node, { ...sq, MOTARD_STARTUP_STATE: "REUSE" });
      handles[node] = { kind: "sqlite", path };
    }
  }
  const date = "2026-10-04";
  const dev = { A: DEV_A, B: DEV_B };
  const call = (node, method, path, body) => api(node, method, path, body, { deviceId: dev[node] });

  // ── online: shared customer + shared roll, number blocks ──
  for (const node of ["A", "B"]) {
    await must(`${node} number blocks`, call(node, "POST", "/api/sync/number-blocks/ensure", { syncDeviceId: dev[node], entityTypes: ["customer", "supplier", "invoice", "invoice_entry"] }));
  }
  const c1 = (await must("A customer C1", call("A", "POST", "/api/customers", { name: "عميل مشترك", phone: "000" }))).id;
  const fabric = (await must("A fabric", call("A", "POST", "/api/inventory/fabrics", { name: "قماش مشترك" }))).id;
  const color = (await must("A color", call("A", "POST", "/api/inventory/colors", { fabricId: fabric, name: "أحمر" }))).id;
  const shared = (await must("A shared roll", call("A", "POST", "/api/inventory/rolls", { colorId: color, rollNo: "R-SHARED", initialKg: 100, pieces: 4, pricePerKg: 10, currency: "USD", entryDate: date }))).id;
  await syncUntilDrained("A");
  await syncUntilDrained("B");
  const bKnows = await call("B", "GET", `/api/customers/${c1}`);
  check("online: B pulled the shared customer and roll", bKnows.status === 200 && (await call("B", "GET", `/api/inventory/rolls?limit=50`)).text.includes("R-SHARED"));

  // ── offline work ──
  async function ownRoll(node) {
    return (await must(`${node} own roll`, call(node, "POST", "/api/inventory/rolls", { colorId: color, rollNo: `R-${node}`, initialKg: 200, pieces: 40, pricePerKg: 9, currency: "USD", entryDate: date }))).id;
  }
  async function sell(node, roll, kg, paid, i) {
    return must(`${node} invoice ${i}`, api(node, "POST", "/api/invoices", {
      type: "sale", date, partyId: c1, partyType: "customer", currency: "USD", paid,
      lines: [{ fabricId: fabric, colorId: color, rollId: roll, quantityKg: kg, pieces: 1, pricePerKg: 12.5 }],
    }, { deviceId: dev[node] }));
  }
  const rollA = await ownRoll("A");
  const rollB = await ownRoll("B");
  for (let i = 0; i < 20; i++) await sell("A", i === 0 ? shared : rollA, i === 0 ? 2 : 1, i % 3 === 0 ? 12.5 : 0, i);
  for (let i = 0; i < 30; i++) await sell("B", i === 0 ? shared : rollB, i === 0 ? 3 : 1.5, i % 4 === 0 ? 18.75 : 0, i);
  // same-record edit on both devices while offline
  for (const [node, phone] of [["A", "111"], ["B", "222"]]) {
    const cur = await must(`${node} read C1`, call(node, "GET", `/api/customers/${c1}`));
    await must(`${node} edit C1`, call(node, "PUT", `/api/customers/${c1}`, { name: cur.name, phone, expectedVersion: cur.version }));
  }

  // ── reconnect ──
  await syncUntilDrained("A");
  await syncUntilDrained("B");
  await syncUntilDrained("A");
  await syncUntilDrained("B");

  // ── convergence ──
  const st = { hub: await stateOf("hub", c1, date), A: await stateOf("A", c1, date), B: await stateOf("B", c1, date) };
  check("50 sale invoices on every node", ["hub", "A", "B"].every((n) => st[n].invoices.length === 50), Object.fromEntries(["hub", "A", "B"].map((n) => [n, st[n].invoices.length])));
  const numbers = st.hub.invoices.map((x) => x.number);
  check("document numbers are unique", new Set(numbers).size === numbers.length);
  for (const k of Object.keys(st.hub)) {
    const h = JSON.stringify(st.hub[k]);
    check(`A ≡ hub: ${k}`, JSON.stringify(st.A[k]) === h, firstDiff(st.A[k], st.hub[k]));
    check(`B ≡ hub: ${k}`, JSON.stringify(st.B[k]) === h, firstDiff(st.B[k], st.hub[k]));
  }
  const sharedRoll = st.hub.rolls.find((r) => r.rollNo === "R-SHARED");
  check("the shared roll lost exactly 2 + 3 kg", sharedRoll && Number(sharedRoll.remainingKg ?? sharedRoll.remaining_kg) === 95, sharedRoll);

  // sync health: nothing stuck
  for (const node of ["A", "B"]) {
    const s = await must(`${node} sync status`, call(node, "GET", "/api/sync/status"));
    check(`${node}: outbox drained, nothing rejected`, (s.pending ?? s.outbox?.pending ?? 0) === 0 && (s.rejected ?? s.outbox?.rejected ?? 0) === 0, s);
  }

  if (OUT) {
    mkdirSync(OUT, { recursive: true });
    const wire = { hubInbox: await inboxOf("hub", handles.hub), aInbox: await inboxOf("A", handles.A), bInbox: await inboxOf("B", handles.B) };
    writeFileSync(join(OUT, `wire-${ENGINE}.raw.json`), JSON.stringify(wire, null, 2));
    writeFileSync(join(OUT, `state-${ENGINE}.raw.json`), JSON.stringify(st.hub, null, 2));
    writeFileSync(join(OUT, `checks-${ENGINE}.json`), JSON.stringify(checks, null, 2));
  }
}

function firstDiff(a, b, path = "") {
  if (JSON.stringify(a) === JSON.stringify(b)) return undefined;
  if (a && b && typeof a === "object" && typeof b === "object") {
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)])) {
      const d = firstDiff(a[k], b[k], `${path}/${k}`);
      if (d) return d;
    }
  }
  return `${path || "/"}: ${JSON.stringify(a)?.slice(0, 160)} ≠ ${JSON.stringify(b)?.slice(0, 160)}`;
}

let failed = 1;
try {
  await main();
  failed = checks.filter((c) => !c.pass).length;
  console.log(`\n${checks.length - failed}/${checks.length} checks passed`);
} catch (e) {
  console.error(String(e?.stack ?? e).replace(/:\/\/[^@\s]*@/g, "://***@"));
} finally {
  for (const p of procs) kill(p);
  await sleep(800);
  if (!KEEP) {
    for (const db of created) await admin(`DROP DATABASE IF EXISTS ${db} WITH (FORCE)`).catch(() => {});
    rmSync(work, { recursive: true, force: true });
  }
}
process.exit(failed ? 1 : 0);
