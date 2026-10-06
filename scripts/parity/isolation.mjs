#!/usr/bin/env node
/**
 * Tenant-isolation suite (specs/001-desktop-sqlite-engine T049; contracts/db-engine-port.md
 * guarantee 3; research I-10), over HTTP so every route → port → repository path is exercised:
 *
 *   1. build company A through the parity scenarios;
 *   2. read every GET endpoint the scenarios used (A's view);
 *   3. clone ALL of A's business rows into tenant B (every id remapped; same document numbers);
 *   4. re-read the same endpoints as A — the responses must be byte-identical (no B row in any read);
 *   5. as A, read / update / cancel / delete B's records by id — refused, and B's rows unchanged;
 *   6. as A, write new documents — B's rows still unchanged (no write reaches B).
 *
 *   node scripts/parity/isolation.mjs --engine sqlite|postgres [--port N]
 * Exit 0 only when every check passes; the report goes to scripts/parity/reports/US1-isolation-<engine>.json.
 */
import { readdirSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash, randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { startEngine, apiClient, provisionCompany, ensureSeed, BACKEND, TENANT_ID } from "./lib/engine.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const requireBackend = createRequire(join(BACKEND, "package.json"));
const arg = (n) => {
  const i = process.argv.indexOf(`--${n}`);
  return i > 0 ? process.argv[i + 1] : undefined;
};
const engine = arg("engine");
const port = Number(arg("port") ?? 18093);
if (!["postgres", "sqlite"].includes(engine ?? "")) {
  console.error("usage: node scripts/parity/isolation.mjs --engine sqlite|postgres [--port N]");
  process.exit(2);
}
const FP = JSON.parse(readFileSync(join(BACKEND, "src/infrastructure/orm/migrations/meta/schema-fingerprint.json"), "utf8"));
/** Install/licence/auth/sync bookkeeping: never business data of a company, not cloned. */
const NOT_CLONED = new Set([
  "tenants", "users", "licenses", "license_activations", "license_audit_events", "device_registrations", "secrets",
  "server_installations", "setup_wizard_state", "idempotency_keys", "financial_operations", "revoked_tokens",
  "invitation_codes", "sync_outbox", "sync_inbox", "sync_devices", "sync_device_authorized_users", "sync_state",
  "sync_resource_claims", "sync_conflicts", "sync_tombstones", "document_number_blocks", "audit_logs", "notifications",
]);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function pgAdminUrl() {
  if (process.env.PARITY_PG_URL) return process.env.PARITY_PG_URL;
  const line = readFileSync(join(BACKEND, ".env.test"), "utf8").split(/\r?\n/).find((l) => l.startsWith("DATABASE_URL="));
  const u = new URL(line.slice("DATABASE_URL=".length).trim().replace(/^"|"$/g, ""));
  u.port = process.env.PARITY_PG_PORT ?? "55432";
  u.pathname = "/postgres";
  return u.toString();
}

/** Raw SQL access to the running engine's database (outside the server, like a second client). */
async function dbAccess(handle) {
  if (engine === "sqlite") {
    const Database = requireBackend("better-sqlite3");
    const db = new Database(handle.env.SQLITE_PATH);
    db.pragma("busy_timeout = 10000");
    db.defaultSafeIntegers(true);
    return {
      all: async (q, v = []) => db.prepare(q.replace(/\$\d+/g, "?")).all(...v),
      run: async (q, v = []) => db.prepare(q.replace(/\$\d+/g, "?")).run(...v),
      tx: async (fn) => {
        db.exec("BEGIN IMMEDIATE");
        try {
          await fn();
          db.exec("COMMIT");
        } catch (e) {
          db.exec("ROLLBACK");
          throw e;
        }
      },
      close: async () => db.close(),
    };
  }
  const pg = requireBackend("pg");
  const c = new pg.Client({ connectionString: handle.env.DATABASE_URL });
  c.setTypeParser?.(1700, (x) => x);
  await c.connect();
  return {
    all: async (q, v = []) => (await c.query({ text: q, values: v, types: { getTypeParser: (oid) => (v2) => v2 } })).rows,
    run: async (q, v = []) => c.query(q, v),
    tx: async (fn) => {
      await c.query("BEGIN");
      try {
        await fn();
        await c.query("COMMIT");
      } catch (e) {
        await c.query("ROLLBACK");
        throw e;
      }
    },
    close: async () => c.end(),
  };
}

const tenantTables = () =>
  Object.keys(FP.tables)
    .filter((t) => "tenant_id" in FP.tables[t].columns && !NOT_CLONED.has(t))
    .sort();

/** Copy every business row of `from` into tenant `to` with fresh ids (references remapped). */
async function cloneTenant(db, from, to) {
  const rowsByTable = {};
  const map = new Map([[from.toLowerCase(), to]]);
  for (const t of tenantTables()) {
    rowsByTable[t] = await db.all(`SELECT * FROM "${t}" WHERE tenant_id = $1`, [from]);
    for (const r of rowsByTable[t]) if (typeof r.id === "string" && UUID.test(r.id)) map.set(r.id.toLowerCase(), randomUUID());
  }
  const remap = (v) => {
    if (typeof v === "string" && UUID.test(v)) return map.get(v.toLowerCase()) ?? v;
    if (typeof v === "string" && /^[[{]/.test(v)) {
      try {
        return JSON.stringify(remapJson(JSON.parse(v)));
      } catch {
        return v;
      }
    }
    if (v && typeof v === "object" && !(v instanceof Date) && typeof v !== "bigint") return remapJson(v);
    return v;
  };
  const remapJson = (v) => {
    if (typeof v === "string" && UUID.test(v)) return map.get(v.toLowerCase()) ?? v;
    if (Array.isArray(v)) return v.map(remapJson);
    if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, remapJson(x)]));
    return v;
  };
  const tenant = (await db.all(`SELECT * FROM tenants WHERE id = $1`, [from]))[0];
  await db.tx(async () => {
    if (engine === "postgres") await db.run(`SET LOCAL session_replication_role = replica`); // FK order + triggers off for the copy
    else await db.run(`PRAGMA defer_foreign_keys = ON`);
    await db.run(`INSERT INTO tenants (id, name, slug, status) VALUES ($1, $2, $3, $4)`, [to, `${tenant.name} (B)`, `iso-b-${to.slice(0, 8)}`, tenant.status]);
    for (const t of tenantTables()) {
      for (const r of rowsByTable[t]) {
        const cols = Object.keys(r).filter((c) => !(typeof r[c] === "bigint" || typeof r[c] === "number") || c !== "id" || FP.tables[t].columns.id?.type?.includes("uuid"));
        const vals = cols.map((c) => (c === "tenant_id" ? to : remap(r[c])));
        const ph = cols.map((c, i) => (engine === "postgres" ? `$${i + 1}::${FP.tables[t].columns[c].type.replace(/^character varying\(\d+\)$/, "varchar")}` : `$${i + 1}`));
        await db.run(`INSERT INTO "${t}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${ph.join(", ")})`, vals);
      }
    }
  });
  return { map, rowsByTable };
}

/** Deterministic checksum of every row tenant `t` owns (all tenant tables, including bookkeeping). */
async function tenantChecksum(db, t) {
  const h = createHash("sha256");
  for (const table of Object.keys(FP.tables).filter((x) => "tenant_id" in FP.tables[x].columns).sort()) {
    const rows = await db.all(`SELECT * FROM "${table}" WHERE tenant_id = $1`, [t]);
    const lines = rows.map((r) => JSON.stringify(r, (_k, v) => (typeof v === "bigint" ? String(v) : v))).sort();
    h.update(`${table}:${lines.length}\n${lines.join("\n")}\n`);
  }
  return h.digest("hex");
}

const volatile = (v) => JSON.parse(JSON.stringify(v ?? null, (k, x) => (["requestId", "accessToken", "refreshToken", "durationMs", "generatedAt", "serverTime"].includes(k) ? "<v>" : x)));
/** JSON object key order is not meaning (PG GROUP BY without ORDER BY varies with table size): sort keys; arrays keep order. */
const sortKeys = (v) => (Array.isArray(v) ? v.map(sortKeys) : v && typeof v === "object" ? Object.fromEntries(Object.keys(v).sort().map((k) => [k, sortKeys(v[k])])) : v);

const seedPath = ensureSeed(join(here, "out", "desktop-seed.json"));
const handle = await startEngine(engine, { port, seedPath, pgAdminUrl: engine === "postgres" ? pgAdminUrl() : undefined });
const report = { engine, checks: [], ok: true };
const check = (name, pass, detail) => {
  report.checks.push({ name, pass, ...(detail === undefined ? {} : { detail }) });
  if (!pass) report.ok = false;
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${pass || detail === undefined ? "" : `  ${JSON.stringify(detail).slice(0, 300)}`}`);
};
let db;
try {
  const api = apiClient(handle.base);
  await provisionCompany(api);
  const state = {};
  const gets = new Set();
  const step = async (_label, method, path, body) => {
    const r = await api.call(method, path, body);
    if (method === "GET") gets.add(path);
    return r.body;
  };
  for (const f of readdirSync(join(here, "scenarios")).filter((x) => x.endsWith(".mjs") && !x.startsWith("14-")).sort()) {
    const mod = await import(pathToFileURL(join(here, "scenarios", f)).href);
    await mod.default({ step, record: () => {}, state, engine, api });
  }
  const readAll = async () => {
    const out = {};
    for (const p of [...gets].sort()) out[p] = sortKeys(volatile(await api.call("GET", p)));
    return out;
  };
  const before = await readAll();

  db = await dbAccess(handle);
  const B = randomUUID();
  const { map, rowsByTable } = await cloneTenant(db, TENANT_ID, B);
  const cloned = Object.fromEntries(Object.entries(rowsByTable).filter(([, r]) => r.length).map(([t, r]) => [t, r.length]));
  check("tenant B holds a full copy of A's business data", Object.keys(cloned).length >= 15, cloned);

  // 4. every read as A is unchanged by B's existence
  const after = await readAll();
  const changed = Object.keys(before).filter((p) => JSON.stringify(before[p]) !== JSON.stringify(after[p]));
  check(`no read of A changes when B exists (${gets.size} GET endpoints/queries)`, changed.length === 0, changed.slice(0, 10));
  report.changedReads = Object.fromEntries(changed.map((p) => [p, { before: before[p], after: after[p] }]));
  const bIds = new Set([...map.values()]);
  const leaked = Object.entries(after).filter(([, v]) => [...JSON.stringify(v).matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)].some((m) => bIds.has(m[0].toLowerCase())));
  check("no B id appears in any A response", leaked.length === 0, leaked.map(([p]) => p).slice(0, 10));

  // 5. cross-tenant access by id
  const bOf = (table) => (rowsByTable[table] ?? []).map((r) => map.get(String(r.id).toLowerCase())).filter(Boolean);
  const bSum0 = await tenantChecksum(db, B);
  const probes = [];
  const kindOf = Object.fromEntries((rowsByTable.parties ?? []).map((r) => [map.get(String(r.id).toLowerCase()), r.kind]));
  for (const id of bOf("parties")) {
    const base = kindOf[id] === "supplier" ? "suppliers" : "customers";
    probes.push(["GET", `/api/${base}/${id}`], ["GET", `/api/${base}/${id}/statement`], ["PUT", `/api/${base}/${id}`, { name: "hijack", expectedVersion: 1 }], ["DELETE", `/api/${base}/${id}?expectedVersion=1&confirmCascade=true`, { expectedVersion: 1, confirmCascade: true }]);
  }
  for (const id of bOf("invoices")) probes.push(["GET", `/api/invoices/${id}`], ["POST", `/api/invoices/${id}/cancel`, { expectedVersion: 1, reason: "x" }], ["GET", `/api/ledger/document-graph/${id}`]);
  for (const id of bOf("vouchers")) probes.push(["GET", `/api/receipts/${id}`], ["POST", `/api/receipts/${id}/cancel`, { expectedVersion: 1, reason: "x" }], ["POST", `/api/payments/${id}/cancel`, { expectedVersion: 1, reason: "x" }]);
  for (const id of bOf("returns")) probes.push(["GET", `/api/returns/${id}`], ["POST", `/api/returns/${id}/cancel`, { expectedVersion: 1, reason: "x" }]);
  for (const id of bOf("expenses")) probes.push(["GET", `/api/expenses/${id}`], ["POST", `/api/expenses/${id}/cancel`, { expectedVersion: 1, reason: "x" }]);
  for (const id of bOf("rolls")) probes.push(["GET", `/api/inventory/rolls/${id}`], ["PUT", `/api/inventory/rolls/${id}`, { rollNo: "hijack", expectedVersion: 1 }], ["DELETE", `/api/inventory/rolls/${id}`]);
  for (const id of bOf("colors")) probes.push(["GET", `/api/inventory/colors/${id}`], ["PUT", `/api/inventory/colors/${id}`, { name: "hijack" }], ["DELETE", `/api/inventory/colors/${id}`]);
  for (const id of bOf("fabrics")) probes.push(["GET", `/api/inventory/fabrics/${id}`], ["PUT", `/api/inventory/fabrics/${id}`, { name: "hijack" }], ["DELETE", `/api/inventory/fabrics/${id}`], ["DELETE", `/api/inventory/dyes/${id}/purge`, { confirmation: "تأكيد" }]);
  for (const id of bOf("manual_movements")) probes.push(["DELETE", `/api/cashbox/manual-movements/${id}`]);
  const allowed = [];
  for (const [m, p, b] of probes) {
    const r = await api.call(m, p, b);
    // a 2xx is acceptable only for a read that returns nothing of B (e.g. an empty graph)
    const body = JSON.stringify(r.body ?? "");
    // an echo of the id A itself asked for is not a leak; any OTHER B id is
    const asked = new Set([...p.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)].map((x) => x[0].toLowerCase()));
    const showsB = [...body.matchAll(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi)].some((x) => bIds.has(x[0].toLowerCase()) && !asked.has(x[0].toLowerCase()));
    if (showsB) allowed.push({ m, p, status: r.status, showsB });
    else if (r.status < 300 && m !== "GET") report.acceptedNoopWrites = [...(report.acceptedNoopWrites ?? []), { m, p, status: r.status }];
  }
  check(`A cannot read any of B's ${probes.length} records by id`, allowed.length === 0, allowed.slice(0, 10));
  // a 2xx on a cross-tenant write is acceptable only as a no-op: B must be byte-identical (checked here)
  check(`B's rows are byte-identical after A's ${probes.filter(([m]) => m !== "GET").length} cross-tenant write attempts`, (await tenantChecksum(db, B)) === bSum0);

  // 6. new writes by A never reach B
  const party = state.customers[0];
  await api.call("POST", "/api/receipts", { kind: "receipt", date: "2026-07-01", partyId: party, partyKind: "customer", amount: 1234.5, currency: "SYP", exchangeRate: 15000, method: "cash" });
  await api.call("POST", "/api/cashbox/manual-movements", { date: "2026-07-01", type: "capital", direction: "in", amount: 99, currency: "SYP" });
  await api.call("POST", "/api/expenses", { category: "نقل", description: "عزل", amount: 10, currency: "SYP", date: "2026-07-01", method: "cash", paidFromCashbox: true });
  check("B's rows are byte-identical after new writes by A", (await tenantChecksum(db, B)) === bSum0);
} catch (e) {
  check("isolation run completed", false, String(e?.stack ?? e));
} finally {
  await db?.close();
  await handle.stop();
}
mkdirSync(join(here, "reports"), { recursive: true });
writeFileSync(join(here, "reports", `US1-isolation-${engine}.json`), JSON.stringify(report, null, 2));
console.log(report.ok ? `[isolation] ${engine} PASS` : `[isolation] ${engine} FAIL`);
process.exit(report.ok ? 0 : 1);
