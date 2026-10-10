#!/usr/bin/env node
/**
 * N-05/N-01 (ERP_VERIFIED_ISSUES_AND_REMEDIATION_PLAN): the desktop runtime is
 * SQLite (`DB_ENGINE=sqlite`, stack.rs spawns the server against
 * `data/motard.db`), but the only reconciliation tool
 * (`reconcile-integrity.mjs`) speaks PostgreSQL exclusively — so 100% of
 * customer installs had NO way to detect stock/ledger/sync drift. This is the
 * SQLite twin: same four read-only checks, better-sqlite3, read-only open so it
 * can never mutate a live desktop database.
 *
 * Usage:
 *   node backend/scripts/reconcile-integrity-sqlite.mjs [--db PATH_TO_MOTARD_DB] [--tenant TENANT_UUID]
 *
 * Defaults: --db %LOCALAPPDATA%/motard-erp/data/motard.db (Windows desktop) or
 * $DATABASE_URL ignored entirely — this tool never touches PostgreSQL.
 *
 * Exit 0 when all checks pass; non-zero with a JSON summary of failures.
 */
import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import process from "node:process";

const args = process.argv.slice(2);
const dbIdx = args.indexOf("--db");
const tenantIdx = args.indexOf("--tenant");

const DEFAULT_DB =
  process.platform === "win32"
    ? join(
        homedir(),
        "AppData",
        "Local",
        "motard-erp",
        "data",
        "motard.db",
      )
    : join(homedir(), ".local", "share", "motard-erp", "data", "motard.db");

const dbPath = (dbIdx !== -1 ? args[dbIdx + 1] : undefined) ?? DEFAULT_DB;

if (!existsSync(dbPath)) {
  console.error(
    JSON.stringify(
      { ok: false, error: `database not found: ${dbPath}`, hint: "pass --db /path/to/motard.db" },
      null,
      2,
    ),
  );
  process.exit(2);
}

// READ-ONLY: this is a diagnostic tool; it must never be able to write.
const db = new Database(dbPath, { readonly: true, fileMustExist: true });
db.pragma("busy_timeout = 5000");

function one(sql, params = []) {
  return db.prepare(sql).get(...params);
}

function all(sql, params = []) {
  return db.prepare(sql).all(...params);
}

let tenantId = tenantIdx !== -1 ? args[tenantIdx + 1] : null;
if (!tenantId) {
  const t = one(`SELECT id FROM tenants ORDER BY created_at IS NULL, created_at LIMIT 1`);
  tenantId = t?.id ?? null;
}
if (!tenantId) {
  console.error(JSON.stringify({ ok: false, error: "no tenant" }, null, 2));
  process.exit(2);
}

const failures = [];

// 1) Stock: remaining_kg vs the last movement's balance_after_kg (movements exist).
// SQLite has no LATERAL; use the correlated subquery form. Scaled-integer money
// columns here are INTEGER (decimal(14,2) scaled by 100 — see sqlite/types.ts),
// so compare in integer space with a 1-unit (0.01 kg) tolerance.
const stock = all(
  `SELECT r.id, r.roll_no, r.remaining_kg AS remaining,
          (SELECT sm.balance_after_kg FROM stock_movements sm
            WHERE sm.roll_id = r.id AND sm.tenant_id = r.tenant_id
            ORDER BY sm.created_at DESC, sm.id DESC LIMIT 1) AS last_balance
     FROM rolls r
    WHERE r.tenant_id = ?
      AND (SELECT sm.balance_after_kg FROM stock_movements sm
            WHERE sm.roll_id = r.id AND sm.tenant_id = r.tenant_id
            ORDER BY sm.created_at DESC, sm.id DESC LIMIT 1) IS NOT NULL
      AND abs(r.remaining_kg - (SELECT sm.balance_after_kg FROM stock_movements sm
            WHERE sm.roll_id = r.id AND sm.tenant_id = r.tenant_id
            ORDER BY sm.created_at DESC, sm.id DESC LIMIT 1)) > 1
    LIMIT 50`,
  [tenantId],
);
if (stock.length) {
  failures.push({ check: "stock_vs_movements", count: stock.length, sample: stock.slice(0, 5) });
}

// 2) Active sale invoice lines without a cost_per_kg snapshot (COGS fallback risk).
const cogsNull = one(
  `SELECT count(*) AS n
     FROM invoice_lines il
     JOIN invoices i ON i.id = il.invoice_id
    WHERE il.tenant_id = ? AND i.type = 'sale' AND i.status = 'active'
      AND il.cost_per_kg IS NULL`,
  [tenantId],
);
if ((cogsNull?.n ?? 0) > 0) {
  failures.push({ check: "null_cost_per_kg", count: cogsNull.n });
}

// 3) Ledger entries pointing at a party that no longer exists.
const orphanLedger = one(
  `SELECT count(*) AS n FROM ledger_entries le
    WHERE le.tenant_id = ? AND le.party_id IS NOT NULL
      AND NOT EXISTS (SELECT 1 FROM parties p WHERE p.id = le.party_id)`,
  [tenantId],
);
if ((orphanLedger?.n ?? 0) > 0) {
  failures.push({ check: "orphan_ledger_party", count: orphanLedger.n });
}

// 4) Dead sync backlog (units parked dead never silently disappear).
const dead = one(
  `SELECT count(*) AS n FROM sync_outbox WHERE tenant_id = ? AND status = 'dead'`,
  [tenantId],
);
if ((dead?.n ?? 0) > 0) {
  failures.push({ check: "sync_dead", count: dead.n });
}

const ok = failures.length === 0;
console.log(JSON.stringify({ ok, tenantId, db: dbPath, failures }, null, 2));
db.close();
process.exit(ok ? 0 : 1);
