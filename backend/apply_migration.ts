import { db } from "./src/infrastructure/orm/drizzle.js";
import { sql } from "drizzle-orm";

async function main() {
  // Apply migration 0023: add paid and payment_method columns to invoices
  await db.execute(
    sql`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS paid REAL NOT NULL DEFAULT 0;`,
  );
  await db.execute(sql`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_method varchar(20);`);
  await db.execute(sql`
    ALTER TABLE invoices DROP CONSTRAINT IF EXISTS chk_invoices_payment_method;
  `);
  await db.execute(sql`
    ALTER TABLE invoices ADD CONSTRAINT chk_invoices_payment_method
      CHECK (payment_method IS NULL OR payment_method IN ('cash', 'transfer', 'check', 'card'));
  `);
  await db.execute(sql`CREATE INDEX IF NOT EXISTS idx_invoices_paid ON invoices(tenant_id, paid);`);

  // Apply migration 0024: convert monetary fields from BIGINT to REAL
  // 1. invoices
  await db.execute(sql`ALTER TABLE invoices ALTER COLUMN subtotal TYPE REAL;`);
  await db.execute(sql`ALTER TABLE invoices ALTER COLUMN discount TYPE REAL;`);
  await db.execute(sql`ALTER TABLE invoices ALTER COLUMN tax TYPE REAL;`);
  await db.execute(sql`ALTER TABLE invoices ALTER COLUMN shipping TYPE REAL;`);
  await db.execute(sql`ALTER TABLE invoices ALTER COLUMN total TYPE REAL;`);
  await db.execute(sql`ALTER TABLE invoices ALTER COLUMN paid TYPE REAL;`);

  // 2. invoice_lines
  await db.execute(sql`ALTER TABLE invoice_lines ALTER COLUMN discount_amount TYPE REAL;`);

  // 3. ledger_entries
  await db.execute(sql`ALTER TABLE ledger_entries ALTER COLUMN debit TYPE REAL;`);
  await db.execute(sql`ALTER TABLE ledger_entries ALTER COLUMN credit TYPE REAL;`);

  // 4. vouchers
  await db.execute(sql`ALTER TABLE vouchers ALTER COLUMN amount TYPE REAL;`);

  // 5. expenses
  await db.execute(sql`ALTER TABLE expenses ALTER COLUMN amount TYPE REAL;`);

  // 6. parties
  await db.execute(sql`ALTER TABLE parties ALTER COLUMN opening_balance TYPE REAL;`);
  await db.execute(sql`ALTER TABLE parties ALTER COLUMN credit_limit TYPE REAL;`);
  await db.execute(sql`ALTER TABLE parties ALTER COLUMN default_discount_amount TYPE REAL;`);

  // 7. party_balances
  await db.execute(sql`ALTER TABLE party_balances ALTER COLUMN balance TYPE REAL;`);

  // 8. yearly_party_summaries
  await db.execute(sql`ALTER TABLE yearly_party_summaries ALTER COLUMN opening_balance TYPE REAL;`);
  await db.execute(sql`ALTER TABLE yearly_party_summaries ALTER COLUMN closing_balance TYPE REAL;`);
  await db.execute(sql`ALTER TABLE yearly_party_summaries ALTER COLUMN total_debit TYPE REAL;`);
  await db.execute(sql`ALTER TABLE yearly_party_summaries ALTER COLUMN total_credit TYPE REAL;`);

  // 9. cashbox_sessions
  await db.execute(sql`ALTER TABLE cashbox_sessions ALTER COLUMN opening_balance TYPE REAL;`);

  // 10. manual_movements
  await db.execute(sql`ALTER TABLE manual_movements ALTER COLUMN amount TYPE REAL;`);

  // 11. day_closes
  await db.execute(sql`ALTER TABLE day_closes ALTER COLUMN opening_balance TYPE REAL;`);
  await db.execute(sql`ALTER TABLE day_closes ALTER COLUMN total_in TYPE REAL;`);
  await db.execute(sql`ALTER TABLE day_closes ALTER COLUMN total_out TYPE REAL;`);
  await db.execute(sql`ALTER TABLE day_closes ALTER COLUMN expected TYPE REAL;`);
  await db.execute(sql`ALTER TABLE day_closes ALTER COLUMN counted TYPE REAL;`);
  await db.execute(sql`ALTER TABLE day_closes ALTER COLUMN difference TYPE REAL;`);

  const res = await db.execute(sql`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'invoices' AND column_name IN ('paid','subtotal','total')
    ORDER BY column_name;
  `);
  console.log(
    "INVOICE COLUMNS:",
    JSON.stringify((res as unknown as { rows: unknown[] }).rows, null, 2),
  );

  const res2 = await db.execute(sql`
    SELECT column_name, data_type
    FROM information_schema.columns
    WHERE table_name = 'invoice_lines' AND column_name = 'discount_amount'
    ORDER BY column_name;
  `);
  console.log(
    "LINE COLUMNS:",
    JSON.stringify((res2 as unknown as { rows: unknown[] }).rows, null, 2),
  );

  process.exit(0);
}
main().catch((e) => {
  console.error("FATAL", e);
  process.exit(1);
});
