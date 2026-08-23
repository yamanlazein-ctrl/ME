import pg from "pg";

const admin = new pg.Client({ connectionString: "postgresql://postgres:postgres@localhost:5432/postgres" });
await admin.connect();

// Safety net: clone the current erp database before wiping (instant, file-level).
const backupName = "erp_backup_before_handoff";
try {
  await admin.query(`CREATE DATABASE "${backupName}" TEMPLATE erp`);
  console.log(`Backup created: ${backupName}`);
} catch (e) {
  if (e.code === "42P04") {
    console.log(`Backup already exists: ${backupName} (skipped)`);
  } else {
    console.error("BACKUP FAILED:", e.message);
    console.error("ABORTING wipe for safety. Close connections to 'erp' and retry.");
    process.exit(1);
  }
}
await admin.end();

// ── Deep clean of business/demo data in `erp` ──
const c = new pg.Client({ connectionString: "postgresql://postgres:postgres@localhost:5432/erp" });
await c.connect();

// Children first → parents last. Kept: tenants, users, settings,
// company_profiles, license/platform tables, drizzle migrations bookkeeping.
const TABLES_TO_WIPE = [
  "stock_movements",
  "invoice_lines",
  "return_lines",
  "order_items",
  "print_jobs",
  // vouchers reference invoices → MUST go before invoices
  "vouchers",
  "returns",
  "orders",
  "invoices",
  "ledger_entry_archive",
  "yearly_party_summaries",
  "ledger_entries",
  "day_closes",
  "manual_movements",
  "cashbox_sessions",
  "expenses",
  "notifications",
  "idempotency_keys",
  "attachments",
  "audit_logs",
  "rolls",
  "colors",
  "fabrics",
  "parties",
  // Reset numbering counters → next document starts at …0001
  "document_sequences",
];

const existing = await c.query(
  "SELECT table_name FROM information_schema.tables WHERE table_schema='public'"
);
const present = new Set(existing.rows.map((r) => r.table_name));

const before = {};
for (const t of TABLES_TO_WIPE) {
  if (!present.has(t)) continue;
  const r = await c.query(`SELECT count(*) AS n FROM "${t}"`);
  before[t] = Number(r.rows[0].n);
}
console.log("ROWS BEFORE WIPE:", JSON.stringify(before));

await c.query("BEGIN");
// The append-only guard on the ledger must be lifted for a zero-data handoff
// wipe, then restored exactly as migration 0036b created it.
await c.query("DROP TRIGGER IF EXISTS trg_ledger_entries_append_only ON ledger_entries");
for (const t of TABLES_TO_WIPE) {
  if (!present.has(t)) continue;
  await c.query(`DELETE FROM "${t}"`);
}
await c.query(
  `CREATE TRIGGER trg_ledger_entries_append_only
   BEFORE UPDATE OR DELETE ON ledger_entries
   FOR EACH ROW EXECUTE FUNCTION fn_ledger_entries_append_only()`,
);
await c.query("COMMIT");

const after = {};
for (const t of TABLES_TO_WIPE) {
  if (!present.has(t)) continue;
  const r = await c.query(`SELECT count(*) AS n FROM "${t}"`);
  after[t] = Number(r.rows[0].n);
}
console.log("ROWS AFTER WIPE:", JSON.stringify(after));

// Proof that the essentials survive.
const kept = {};
for (const t of ["tenants", "users", "settings", "company_profiles"]) {
  if (!present.has(t)) continue;
  const r = await c.query(`SELECT count(*) AS n FROM "${t}"`);
  kept[t] = Number(r.rows[0].n);
}
console.log("KEPT (admin & static config):", JSON.stringify(kept));
await c.end();
