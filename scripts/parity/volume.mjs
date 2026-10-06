#!/usr/bin/env node
/**
 * Volume and history completeness on the SQLite build (specs/001-desktop-sqlite-engine T111, AC-9,
 * SC-008, quickstart §7).
 *
 *   node scripts/parity/volume.mjs [--baseline scripts/parity/baseline/completeness.json]
 *                                  [--invoices N --parties N]   (default: the baseline's params)
 *                                  [--out scripts/parity/out/volume.json] [--keep]
 *
 * 1. Creates a fresh SQLite company database through the production FRESH boot.
 * 2. Seeds EXACTLY the dataset of scripts/parity/seed-volume.mjs (T025): same tenant id, same
 *    md5-derived UUIDs, numbers, dates, amounts; one debit and one cash receipt ledger row per invoice
 *    (the SQLite cash-box triggers maintain cashbox_daily_balances as PG's do).
 * 3. Recomputes the completeness baseline with the same predicates and statement order
 *    (date, created_at, id) and compares it with the PG baseline — counts, deepest statement and the
 *    sha256 over every statement's ordered ledger ids must be identical.
 * 4. Starts the real backend on that file and measures the OQ-4 targets on real endpoints:
 *    customer/supplier/invoice list first page (< 2 s), statement first page (< 2 s), full
 *    single-party statement of the deepest party (< 10 s, every page followed, line count checked),
 *    and walks every list to the end through its keyset cursor (row counts must equal the baseline).
 *
 * No limits are added anywhere: completeness is checked against the full baseline.
 */
import { createHash } from "node:crypto";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "../..");
const BACKEND = join(REPO, "backend");
const requireBackend = createRequire(join(BACKEND, "package.json"));
const Database = requireBackend("better-sqlite3");
const { SignJWT } = requireBackend("jose");
const FP = JSON.parse(readFileSync(join(BACKEND, "src/infrastructure/orm/migrations/meta/schema-fingerprint.json"), "utf8"));

const arg = (f, d) => {
  const i = process.argv.indexOf(f);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const baselinePath = resolve(REPO, arg("--baseline", "scripts/parity/baseline/completeness.json"));
const baseline = JSON.parse(readFileSync(baselinePath, "utf8"));
const INVOICES = Number(arg("--invoices", baseline.params.invoices));
const PARTIES = Number(arg("--parties", baseline.params.parties));
const OUT = resolve(REPO, arg("--out", "scripts/parity/out/volume.json"));
const KEEP = process.argv.includes("--keep");
const PORT = Number(arg("--port", "18300"));
const tenantId = baseline.tenantId;
const USER_ID = "22222222-2222-4222-8222-2222222222aa";
const JWT_SECRET = "volume-harness-jwt-secret-32-chars-minimum!!";
const TARGET = { listMs: 2000, statementFirstMs: 2000, statementFullMs: 10000 };

if (INVOICES !== baseline.params.invoices || PARTIES !== baseline.params.parties) {
  console.warn(`[volume] params ${INVOICES}/${PARTIES} differ from the baseline's — completeness is reported, not compared`);
}

// ── helpers identical to PG expressions in seed-volume.mjs ──────────────────
/** PG `md5(text)::uuid`. */
const md5uuid = (s) => {
  const h = createHash("md5").update(s).digest("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
};
/** PG `DATE '2022-01-01' + n`. */
const addDays = (n) => new Date(Date.UTC(2022, 0, 1) + n * 86_400_000).toISOString().slice(0, 10);
/** numeric(p,s) column → the scaled integer SQLite stores (T032). */
const scaleOf = (table, col) => {
  const m = /^numeric\(\d+,(\d+)\)$/.exec(FP.tables[table].columns[col].type);
  if (!m) throw new Error(`${table}.${col} is not numeric`);
  return 10n ** BigInt(m[1]);
};
const scaled = (table, col, v) => BigInt(v) * scaleOf(table, col);

// ── 1. fresh database ──────────────────────────────────────────────────────
const work = mkdtempSync(join(tmpdir(), "motard-volume-"));
const dbPath = join(work, "data", "motard.db");
mkdirSync(dirname(dbPath), { recursive: true });
{
  const r = spawnSync(process.execPath, [join(BACKEND, "node_modules/tsx/dist/cli.mjs"), join(here, "lib/sqliteFresh.mts"), dbPath], {
    cwd: BACKEND,
    env: { ...process.env, DB_ENGINE: "sqlite", SQLITE_PATH: dbPath },
    encoding: "utf8",
  });
  if (r.status !== 0) throw new Error(`sqliteFresh failed:\n${(r.stdout ?? "") + (r.stderr ?? "")}`);
}

// ── 2. seed (same rows as seed-volume.mjs) ─────────────────────────────────
const t0 = Date.now();
const customers = Math.round(PARTIES * 0.8);
const deepShare = Math.round(INVOICES * 0.2);
{
  const db = new Database(dbPath);
  db.pragma("foreign_keys = ON");
  db.exec("BEGIN IMMEDIATE");
  // One transaction: every row shares the transaction clock, as in the single PG transaction (the app
  // supplies created_at from that clock; the DDL default is wall time, so it is passed explicitly here).
  const ts = new Date().toISOString().replace("Z", "000Z");
  db.prepare(`UPDATE motard_tx_state SET ts = ? WHERE id = 1`).run(ts);
  db.prepare(`INSERT INTO tenants (id, name, slug) VALUES (?, 'Volume Co', ?)`).run(tenantId, `vol-${tenantId.slice(0, 8)}`);
  db.prepare(`INSERT INTO users (id, tenant_id, name, email, password_hash, role, active) VALUES (?, ?, 'Volume Admin', 'volume@local', 'not-used', 'admin', 1)`).run(USER_ID, tenantId);
  db.prepare(`INSERT INTO setup_wizard_state (tenant_id, current_step, completed_steps, is_completed, completed_at) VALUES (?, 'done', '["welcome"]', 1, ?)`).run(tenantId, ts);
  const party = db.prepare(
    `INSERT INTO parties (id, tenant_id, kind, code, name, currency, opening_balance, status, version, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'SYP', 0, 'active', 1, ?, ?)`,
  );
  for (let g = 1; g <= PARTIES; g++) {
    party.run(md5uuid(`${tenantId}:p:${g}`), tenantId, g <= customers ? "customer" : "supplier", `P-${String(g).padStart(6, "0")}`, `Party ${g}`, ts, ts);
  }
  const inv = db.prepare(
    `INSERT INTO invoices (id, tenant_id, number, type, date, party_id, party_type, currency, subtotal, discount, tax, shipping, total, paid, status, version, created_at, updated_at)
     VALUES (?, ?, ?, 'sale', ?, ?, 'customer', 'SYP', ?, 0, 0, 0, ?, 0, 'active', 1, ?, ?)`,
  );
  const led = db.prepare(
    `INSERT INTO ledger_entries (id, tenant_id, party_id, date, type, debit, credit, currency, cash_impact, reference_type, reference_id, reference_number, status, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'SYP', ?, ?, ?, ?, 'active', ?)`,
  );
  // Rows are recomputed per pass (not held in memory): the 1M soak (T113) would need ~1 GB otherwise.
  const rowOf = (g) => {
    const id = md5uuid(`${tenantId}:i:${g}`);
    return {
      id,
      date: addDays(Math.floor((g * 1461) / INVOICES)),
      partyId: md5uuid(`${tenantId}:p:${g <= deepShare ? 1 : 1 + (g % customers)}`),
      total: 1000 + (g % 997),
      number: `INV-${String(g).padStart(7, "0")}`,
    };
  };
  for (let g = 1; g <= INVOICES; g++) {
    const r = rowOf(g);
    inv.run(r.id, tenantId, r.number, r.date, r.partyId, scaled("invoices", "subtotal", r.total), scaled("invoices", "total", r.total), ts, ts);
  }
  // Same statement order as PG: all debit legs, then all receipt legs (the two INSERT…SELECTs).
  for (let g = 1; g <= INVOICES; g++) {
    const r = rowOf(g);
    led.run(md5uuid(`${r.id}:d`), tenantId, r.partyId, r.date, "sales_invoice", scaled("ledger_entries", "debit", r.total), 0n, "none", "sales_invoice", r.id, r.number, ts);
  }
  for (let g = 1; g <= INVOICES; g++) {
    const r = rowOf(g);
    led.run(md5uuid(`${r.id}:c`), tenantId, r.partyId, r.date, "receipt_in", 0n, scaled("ledger_entries", "credit", r.total), "in", "receipt_in", r.id, r.number, ts);
  }
  db.prepare(`UPDATE motard_tx_state SET ts = NULL WHERE id = 1`).run();
  db.exec("COMMIT");
  db.close();
}
const seedSeconds = (Date.now() - t0) / 1000;
console.log(`[volume] seeded ${INVOICES} invoices / ${INVOICES * 2} ledger rows / ${PARTIES} parties in ${seedSeconds.toFixed(1)}s`);

// ── 3. completeness (same predicates as seed-volume.mjs) ───────────────────
const completeness = (() => {
  const db = new Database(dbPath, { readonly: true });
  const n = (q) => Number(db.prepare(q).pluck().get(tenantId));
  const counts = {
    customersList: n(`SELECT count(*) FROM parties WHERE tenant_id = ? AND kind = 'customer' AND status <> 'cancelled'`),
    suppliersList: n(`SELECT count(*) FROM parties WHERE tenant_id = ? AND kind = 'supplier' AND status <> 'cancelled'`),
    invoices: n(`SELECT count(*) FROM invoices WHERE tenant_id = ?`),
    ledgerRows: n(`SELECT count(*) FROM ledger_entries WHERE tenant_id = ?`),
    cashboxDailyRows: n(`SELECT count(*) FROM cashbox_daily_balances WHERE tenant_id = ?`),
  };
  const h = createHash("sha256");
  let totalLines = 0;
  let deepest = { party: null, lines: 0 };
  const per = db
    .prepare(
      `SELECT party_id AS p, group_concat(id, ',' ORDER BY date, created_at, id) AS ids, count(*) AS n
         FROM ledger_entries WHERE tenant_id = ? AND status = 'active' GROUP BY party_id ORDER BY party_id`,
    )
    .all(tenantId);
  for (const r of per) {
    h.update(`${r.p}:${r.ids}\n`);
    totalLines += Number(r.n);
    if (Number(r.n) > deepest.lines) deepest = { party: r.p, lines: Number(r.n) };
  }
  const closing = db
    .prepare(`SELECT closing_balance FROM cashbox_daily_balances WHERE tenant_id = ? AND currency = 'SYP' ORDER BY balance_date DESC LIMIT 1`)
    .pluck()
    .get(tenantId);
  db.close();
  const scale = scaleOf("cashbox_daily_balances", "closing_balance");
  const closingText = closing == null ? null : `${BigInt(closing) / scale}.${String(BigInt(closing) % scale).padStart(String(scale).length - 1, "0")}`;
  return { counts, statements: { parties: per.length, totalLines, deepest, sha256: h.digest("hex") }, cashboxClosingSYP: closingText };
})();

const checks = [];
const check = (name, pass, detail = "") => {
  checks.push({ name, pass, detail });
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}${detail ? ` — ${detail}` : ""}`);
};
const comparable = INVOICES === baseline.params.invoices && PARTIES === baseline.params.parties;
if (comparable) {
  for (const k of Object.keys(baseline.counts)) check(`completeness: ${k} = PG baseline`, completeness.counts[k] === baseline.counts[k], `${completeness.counts[k]} vs ${baseline.counts[k]}`);
  check("completeness: statement parties/lines = PG baseline", completeness.statements.parties === baseline.statements.parties && completeness.statements.totalLines === baseline.statements.totalLines, `${completeness.statements.parties}/${completeness.statements.totalLines}`);
  check("completeness: deepest statement = PG baseline", JSON.stringify(completeness.statements.deepest) === JSON.stringify(baseline.statements.deepest), JSON.stringify(completeness.statements.deepest));
  check("completeness: sha256 over every statement's ordered ledger ids = PG baseline", completeness.statements.sha256 === baseline.statements.sha256);
  check("cash box closing balance = PG baseline", completeness.cashboxClosingSYP === baseline.cashboxClosingSYP, `${completeness.cashboxClosingSYP} vs ${baseline.cashboxClosingSYP}`);
}

// ── 4. real endpoints on the real backend ──────────────────────────────────
const log = join(work, "backend.log");
const env = { ...process.env, NODE_ENV: "test", DB_ENGINE: "sqlite", SQLITE_PATH: dbPath, MOTARD_STARTUP_STATE: "OPEN_EXISTING", PORT: String(PORT), HOST: "127.0.0.1", JWT_SECRET, APP_MASTER_KEY: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa=", LOG_LEVEL: "warn", RATE_LIMIT_RPS: "100000", RATE_LIMIT_WINDOW_MS: "60000" };
for (const k of ["DATABASE_URL", "TEST_DB_URL", "DESKTOP_DEPLOY", "DESKTOP_PIPE", "CENTRAL_SYNC_URL"]) delete env[k];
// --server <server.mjs>: measure a packaged build (T119) with its own bundled migrations.
const packaged = arg("--server", null);
if (packaged) env.DESKTOP_SQLITE_MIGRATIONS_FOLDER = join(dirname(resolve(packaged)), "sqlite-migrations");
const server = spawn(process.execPath, packaged ? [resolve(packaged)] : [join(BACKEND, "node_modules/tsx/dist/cli.mjs"), "src/presentation/server.ts"], { cwd: BACKEND, env, stdio: ["ignore", openSync(log, "w"), openSync(log, "a")] });
const kill = () => {
  if (server.exitCode !== null) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
  else server.kill("SIGKILL");
};
const timings = {};
try {
  const deadline = Date.now() + 240_000;
  for (;;) {
    try {
      if ((await fetch(`http://127.0.0.1:${PORT}/api/health/live`)).ok) break;
    } catch {
      /* not up yet */
    }
    if (Date.now() > deadline || server.exitCode !== null) throw new Error(`backend did not start:\n${existsSync(log) ? readFileSync(log, "utf8").slice(-3000) : ""}`);
    await new Promise((r) => setTimeout(r, 500));
  }
  const token = await new SignJWT({ sub: USER_ID, tenantId, role: "admin", type: "access" })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + 7200)
    .sign(new TextEncoder().encode(JWT_SECRET));
  const get = async (path) => {
    const s = performance.now();
    const r = await fetch(`http://127.0.0.1:${PORT}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    const body = await r.json().catch(() => null);
    const ms = performance.now() - s;
    if (r.status !== 200) throw new Error(`GET ${path}: HTTP ${r.status} ${JSON.stringify(body).slice(0, 300)}`);
    return { body, ms };
  };
  const rowsOf = (b) => b?.data ?? b?.items ?? b?.entries ?? (Array.isArray(b) ? b : []);
  const nextOf = (b) => b?.nextCursor ?? b?.meta?.nextCursor ?? b?.pagination?.nextCursor ?? b?.page?.nextCursor ?? null;
  // warm-up (first request compiles routes, opens statements)
  await get(`/api/customers?limit=50`);

  /** First page timing, then the whole list through its keyset cursor. */
  const walk = async (label, base, sep, expected) => {
    const first = await get(`${base}${sep}limit=50`);
    timings[`${label}.firstPageMs`] = Math.round(first.ms);
    check(`${label}: first page < ${TARGET.listMs} ms`, first.ms < TARGET.listMs, `${Math.round(first.ms)} ms`);
    let total = 0;
    let cursor = null;
    let pages = 0;
    const s = performance.now();
    const seen = new Set();
    do {
      const r = await get(`${base}${sep}limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`);
      total += rowsOf(r.body).length;
      cursor = nextOf(r.body);
      pages++;
      if (cursor && seen.has(cursor)) throw new Error(`${label}: cursor did not advance`);
      if (cursor) seen.add(cursor);
    } while (cursor);
    timings[`${label}.fullWalkMs`] = Math.round(performance.now() - s);
    if (expected !== undefined) check(`${label}: every row reachable (${pages} pages)`, total === expected, `${total} vs ${expected}`);
    return total;
  };
  await walk("customers", "/api/customers", "?", completeness.counts.customersList);
  await walk("suppliers", "/api/suppliers", "?", completeness.counts.suppliersList);
  await walk("invoices", "/api/invoices", "?", completeness.counts.invoices);

  const deep = completeness.statements.deepest.party;
  const first = await get(`/api/customers/${deep}/statement?limit=200`);
  timings["statement.firstPageMs"] = Math.round(first.ms);
  check(`statement first page < ${TARGET.statementFirstMs} ms`, first.ms < TARGET.statementFirstMs, `${Math.round(first.ms)} ms`);
  // Full single-party statement exactly as the UI loads it (useStatement → fetchFullStatement: limit 500, follow nextCursor).
  const s = performance.now();
  let lines = rowsOf(first.body).length;
  let page = first.body?.page;
  let pages = 1;
  const seen = new Set();
  while (page?.hasMore && page.nextCursor) {
    if (seen.has(page.nextCursor)) throw new Error("statement cursor did not advance");
    seen.add(page.nextCursor);
    const r = await get(`/api/customers/${deep}/statement?limit=500&cursor=${encodeURIComponent(page.nextCursor)}`);
    lines += rowsOf(r.body).length;
    page = r.body?.page;
    pages++;
  }
  const fullMs = performance.now() - s + first.ms;
  timings["statement.fullMs"] = Math.round(fullMs);
  timings["statement.pages"] = pages;
  check(`full single-party statement < ${TARGET.statementFullMs} ms`, fullMs < TARGET.statementFullMs, `${Math.round(fullMs)} ms, ${pages} pages`);
  check("full statement line count = deepest party's ledger rows", lines === completeness.statements.deepest.lines, `${lines} vs ${completeness.statements.deepest.lines}`);
} finally {
  kill();
}

const failed = checks.filter((c) => !c.pass);
const report = { generatedAt: new Date().toISOString(), engine: "sqlite", params: { invoices: INVOICES, parties: PARTIES }, seedSeconds, completeness, timings, targets: TARGET, checks, pass: failed.length === 0 };
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");
console.log(`[volume] ${checks.length - failed.length}/${checks.length} checks passed → ${OUT}`);
if (!KEEP) rmSync(work, { recursive: true, force: true });
else console.log(`[volume] kept ${work}`);
process.exit(failed.length ? 1 : 0);
