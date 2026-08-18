-- Migration: Add paid and payment_method columns to invoices table
-- Date: 2026-08-17
-- 
-- Fixes the audit finding: "المدفوع (paid) غير محفوظ إطلاقاً لفواتير الدخول"
-- The application code already supports these fields (invoice.table.ts,
-- invoice.schema.ts, PostgresInvoiceRepository.ts), but the database column
-- was never created.
--
-- paid: Amount paid at invoice time. For entry (purchase) invoices this is
--       the supplier payment; for sale invoices it is the customer receipt.
--       Enables amountDue = total - paid and correct party balance.
--
-- payment_method: The method used for the payment (cash/transfer/check/card).
--       Stored on the invoice for audit trail and display purposes.

-- 1. Add paid column (bigint, default 0 for backward compatibility)
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS paid BIGINT NOT NULL DEFAULT 0;

-- 2. Add payment_method column (nullable, only set when paid > 0)
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS payment_method VARCHAR(20);

-- 3. Add check constraint for valid payment methods
ALTER TABLE invoices DROP CONSTRAINT IF EXISTS chk_invoices_payment_method;
ALTER TABLE invoices ADD CONSTRAINT chk_invoices_payment_method
  CHECK (payment_method IS NULL OR payment_method IN ('cash', 'transfer', 'check', 'card'));

-- 4. Update existing data: ensure paid is 0 for all existing rows
UPDATE invoices SET paid = 0 WHERE paid IS NULL;

-- 5. Create index for queries filtering by paid status
CREATE INDEX IF NOT EXISTS idx_invoices_paid ON invoices(tenant_id, paid);