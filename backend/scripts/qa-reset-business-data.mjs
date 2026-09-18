/**
 * QA-only: wipe business data from local erp DB (schema kept).
 * Connects as local postgres superuser to bypass RLS / TRUNCATE ACL.
 * Refuses non-local hosts and non-erp database names.
 */
import "dotenv/config";
import pg from "pg";

const appUrl = process.env.DATABASE_URL;
if (!appUrl) {
  console.error("NO_DATABASE_URL");
  process.exit(1);
}
const app = new URL(appUrl);
const dbName = app.pathname.replace(/^\//, "");
if (dbName !== "erp") {
  console.error(`REFUSING: expected database name 'erp', got '${dbName}'`);
  process.exit(2);
}
if (!["localhost", "127.0.0.1"].includes(app.hostname)) {
  console.error(`REFUSING: non-local host '${app.hostname}'`);
  process.exit(2);
}

const adminUrl =
  process.env.ADMIN_DATABASE_URL ||
  process.env.QA_ADMIN_DATABASE_URL ||
  `postgresql://postgres:postgres@${app.hostname}:${app.port || 5432}/${dbName}`;

const client = new pg.Client({ connectionString: adminUrl });
await client.connect();
const who = await client.query("SELECT current_user AS usr, current_database() AS db");
console.log("connected", who.rows[0]);
if (who.rows[0].db !== "erp") {
  console.error("REFUSING unexpected db");
  process.exit(2);
}

const countsSql = `
SELECT * FROM (
  SELECT 'fabrics' t, count(*)::int n FROM fabrics
  UNION ALL SELECT 'colors', count(*) FROM colors
  UNION ALL SELECT 'rolls', count(*) FROM rolls
  UNION ALL SELECT 'invoices', count(*) FROM invoices
  UNION ALL SELECT 'invoice_lines', count(*) FROM invoice_lines
  UNION ALL SELECT 'vouchers', count(*) FROM vouchers
  UNION ALL SELECT 'returns', count(*) FROM returns
  UNION ALL SELECT 'return_lines', count(*) FROM return_lines
  UNION ALL SELECT 'expenses', count(*) FROM expenses
  UNION ALL SELECT 'ledger_entries', count(*) FROM ledger_entries
  UNION ALL SELECT 'stock_movements', count(*) FROM stock_movements
  UNION ALL SELECT 'orders', count(*) FROM orders
  UNION ALL SELECT 'order_items', count(*) FROM order_items
  UNION ALL SELECT 'print_jobs', count(*) FROM print_jobs
  UNION ALL SELECT 'parties', count(*) FROM parties
  UNION ALL SELECT 'attachments', count(*) FROM attachments
  UNION ALL SELECT 'notifications', count(*) FROM notifications
  UNION ALL SELECT 'audit_logs', count(*) FROM audit_logs
  UNION ALL SELECT 'manual_movements', count(*) FROM manual_movements
  UNION ALL SELECT 'cashbox_sessions', count(*) FROM cashbox_sessions
  UNION ALL SELECT 'day_closes', count(*) FROM day_closes
  UNION ALL SELECT 'tenants', count(*) FROM tenants
  UNION ALL SELECT 'users', count(*) FROM users
  UNION ALL SELECT 'settings', count(*) FROM settings
) s ORDER BY t`;

console.log("BEFORE:");
console.table((await client.query(countsSql)).rows);

await client.query("BEGIN");
try {
  // Discover optional tables that may not exist on every schema revision.
  const existing = await client.query(`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  `);
  const have = new Set(existing.rows.map((r) => r.tablename));

  const candidates = [
    "invoice_lines",
    "invoices",
    "return_lines",
    "returns",
    "order_items",
    "orders",
    "vouchers",
    "expenses",
    "ledger_entries",
    "ledger_entry_archive",
    "stock_movements",
    "print_jobs",
    "rolls",
    "colors",
    "fabrics",
    "parties",
    "attachments",
    "notifications",
    "audit_logs",
    "manual_movements",
    "cashbox_sessions",
    "day_closes",
    "yearly_party_summaries",
    "sync_outbox",
    "sync_inbox",
    "sync_resource_claims",
    "idempotency_keys",
    "document_number_blocks",
  ];
  const tables = candidates.filter((t) => have.has(t));
  if (tables.length === 0) throw new Error("no business tables found");

  await client.query(`TRUNCATE TABLE ${tables.join(", ")} RESTART IDENTITY CASCADE`);

  if (have.has("document_sequences")) {
    await client.query(`UPDATE document_sequences SET last_number = 0 WHERE TRUE`);
  }

  await client.query("COMMIT");
} catch (e) {
  await client.query("ROLLBACK");
  throw e;
}

console.log("AFTER:");
const after = (await client.query(countsSql)).rows;
console.table(after);

const keep = new Set(["tenants", "users", "settings"]);
const dirty = after.filter((r) => !keep.has(r.t) && Number(r.n) > 0);
if (dirty.length) {
  console.error("QA RESET INCOMPLETE", dirty);
  process.exit(3);
}
console.log("QA_RESET_CLEAN=true");
await client.end();
