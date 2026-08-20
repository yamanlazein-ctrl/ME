-- Migration: backfill invoices.paid from active vouchers (fix P0-LOGIC-3.3)
-- Before this fix paid was written once at creation and never updated when
-- vouchers were collected or cancelled. This migration recomputes paid as
-- the sum of active linked vouchers per invoice, so amountDue = total - paid
-- matches the ledger. Idempotent: rerunning is safe.
UPDATE invoices i
SET paid = COALESCE(v.sum_amount, 0),
    updated_at = NOW()
FROM (
  SELECT invoice_id, SUM(amount)::bigint AS sum_amount
  FROM vouchers
  WHERE status = 'active' AND invoice_id IS NOT NULL
  GROUP BY invoice_id
) v
WHERE i.id = v.invoice_id;

-- Invoices with no active vouchers but with a stored paid>0 that has no
-- corresponding voucher (creation-time paid without linked voucher due to
-- pre-fix bug) are left as-is; the linked voucher path now creates the
-- voucher atomically, so future rows are correct. Historical over-paid rows
-- where paid > total are clamped by application guard but not auto-corrected
-- here to avoid silent data loss; they will be flagged by the trial-balance
-- test.
