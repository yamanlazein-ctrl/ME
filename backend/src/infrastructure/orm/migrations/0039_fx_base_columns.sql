-- 0039: formalise FX / base-currency columns that previously existed only
-- via drizzle-kit push on the dev database (schema drift).
--
-- MUST run before 0040_purchase_double_entry_restore: PART B of 0040
-- UPDATEs ledger_entries.exchange_rate / base_debit / base_credit.
-- Without this file, migrate() from a blank catalog fails at 0040 with
-- "column exchange_rate of relation ledger_entries does not exist".
--
-- Types match the Drizzle schema (invoice.table / return.table /
-- voucher.table / ledger-entry.table):
--   exchange_rate  numeric(18,6)
--   base_*         numeric(14,2)
--
-- Idempotent: ADD COLUMN IF NOT EXISTS -- safe on databases that already
-- received these columns from an earlier push.

ALTER TABLE "invoices"       ADD COLUMN IF NOT EXISTS "exchange_rate" numeric(18,6);
ALTER TABLE "invoices"       ADD COLUMN IF NOT EXISTS "base_total"    numeric(14,2);
ALTER TABLE "invoices"       ADD COLUMN IF NOT EXISTS "base_paid"     numeric(14,2);

ALTER TABLE "returns"        ADD COLUMN IF NOT EXISTS "exchange_rate" numeric(18,6);
ALTER TABLE "returns"        ADD COLUMN IF NOT EXISTS "base_total"    numeric(14,2);

ALTER TABLE "vouchers"       ADD COLUMN IF NOT EXISTS "exchange_rate" numeric(18,6);

ALTER TABLE "ledger_entries" ADD COLUMN IF NOT EXISTS "exchange_rate" numeric(18,6);
ALTER TABLE "ledger_entries" ADD COLUMN IF NOT EXISTS "base_debit"    numeric(14,2);
ALTER TABLE "ledger_entries" ADD COLUMN IF NOT EXISTS "base_credit"   numeric(14,2);
