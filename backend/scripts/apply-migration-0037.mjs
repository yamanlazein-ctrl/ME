/**
 * Applies migrations/0037_monetary_decimal_completion.sql to DATABASE_URL.
 * Idempotent — safe to re-run.
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: join(here, "..", ".env") });

const sql = readFileSync(
  join(here, "..", "src", "infrastructure", "orm", "migrations", "0037_monetary_decimal_completion.sql"),
  "utf8",
);

const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
await client.connect();
try {
  await client.query(sql);
  console.log("✅ migration 0037 applied");
  const { rows } = await client.query(`
    SELECT table_name, column_name, data_type
    FROM information_schema.columns
    WHERE (table_name = 'invoices' AND column_name IN ('subtotal','discount','tax','shipping','total','paid'))
       OR (table_name = 'invoice_lines' AND column_name IN ('quantity_kg','price_per_kg','discount_amount'))
       OR (table_name = 'ledger_entries' AND column_name IN ('debit','credit'))
    ORDER BY table_name, column_name
  `);
  for (const r of rows) console.log(`   ${r.table_name}.${r.column_name} → ${r.data_type}`);
} finally {
  await client.end();
}
