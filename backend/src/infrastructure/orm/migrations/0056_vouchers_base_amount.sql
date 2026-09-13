-- Backfill a schema/migration drift (found live during P5 verification).
--
-- Why this exists:
--   * `voucher.table.ts` defines `base_amount numeric(14,2)` (the frozen
--     USD-equivalent captured at creation, mirroring invoices.base_total),
--     but no migration ever created the column. Any database migrated purely
--     from `migrations/*.sql` — including the test database — rejects every
--     voucher insert with `42703 column "base_amount" does not exist`.
--   * Nullable with no backfill: historical rows simply lack a frozen
--     equivalent (they were written before the capture existed), which is
--     honest — fabricating values for old rows would corrupt history.
--   * A full schema-vs-database drift audit across ALL tables remains P8
--     release-safety work; this migration unblocks the voucher paths P5 must
--     prove. The journal-guard suite pins its registration.

ALTER TABLE "vouchers" ADD COLUMN IF NOT EXISTS "base_amount" numeric(14, 2);
