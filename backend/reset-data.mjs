import pg from "pg";

const url = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/erp";
const TENANT = process.env.TENANT_ID || "407fccfc-ba89-41c5-b5b9-ddb2c4f385d9";
const c = new pg.Client({ connectionString: url });
await c.connect();

const order = [
  // deepest children first
  ["ledger_entries"],
  ["ledger_entry_archive"],
  ["yearly_party_summaries"],
  ["vouchers"],
  ["stock_movements"],
  ["invoice_lines"],
  ["return_lines"],
  ["order_items"],
  ["returns"],
  ["print_jobs"],
  ["orders"],
  ["invoices"],
  ["cashbox_sessions"],
  ["day_closes"],
  ["manual_movements"],
  ["expenses"],
  ["notifications"],
  ["idempotency_keys"],
  ["attachments"],
  ["audit_logs"],
  ["rolls"],
  ["colors"],
  ["fabrics"],
  ["parties"],
];

const results = {};
try {
  await c.query("BEGIN");
  for (const [table] of order) {
    try {
      const r = await c.query(`DELETE FROM "${table}" WHERE tenant_id = $1`, [TENANT]);
      results[table] = r.rowCount;
    } catch (e) {
      results[table] = "ERR: " + (e && e.message || String(e)).slice(0, 100);
    }
  }
  await c.query("COMMIT");
  console.log("DELETE RESULTS:", JSON.stringify(results, null, 2));
} catch (e) {
  await c.query("ROLLBACK");
  console.error("TRANSACTION FAILED, rolled back:", e);
  process.exit(1);
}

// Verify empty
const checks = ["parties", "fabrics", "colors", "rolls", "invoices", "invoice_lines", "vouchers", "ledger_entries", "orders", "returns"];
const verify = {};
for (const t of checks) {
  const r = await c.query(`SELECT count(*) AS n FROM "${t}"`);
  verify[t] = r.rows[0].n;
}
console.log("VERIFY:", JSON.stringify(verify));
await c.end();
process.exit(0);