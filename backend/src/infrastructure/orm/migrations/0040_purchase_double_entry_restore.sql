-- Migration: restore standard double-entry for supplier-side documents
-- (reverts the C-8/BUG-3 "uniform debit = owed" supplier convention to the
-- original "Dr inventory / Cr AP" contract documented by 0030).
--
-- Standard signs after this migration:
--   purchase_invoice    : Dr inventory / Cr supplier (AP)
--   purchase_return     : Dr supplier (AP decreases) / Cr inventory
--   payment_out         : Dr supplier (AP decreases) / Cr cash
--   receipt_in          : Cr customer (AR decreases) / Dr cash   (unchanged)
--   opening (customer)  : positive Dr / negative Cr             (unchanged)
--   opening (supplier)  : positive Cr / negative Dr             (flipped)
--
-- The ledger is append-only (0036b). This migration temporarily drops that
-- trigger, flips the historical rows to the new convention, then re-creates it.
-- Idempotent: raw flips match ONLY the old pattern, and the base recomputation
-- at the end normalizes base_debit/base_credit = amount/exchange_rate for every
-- affected leg (also fixes the pre-existing base-column inversion on legacy
-- purchase_invoice party legs, where the USD equivalent had been stored in
-- base_credit for a raw debit).

BEGIN;

DROP TRIGGER IF EXISTS trg_ledger_entries_append_only ON ledger_entries;

-- ── Flip raw debit/credit (idempotent: only matches the OLD direction) ──

-- 1. purchase_invoice party leg (supplier): Dr -> Cr
UPDATE ledger_entries
SET debit = 0, credit = debit
WHERE type = 'purchase_invoice' AND debit > 0 AND credit = 0
  AND party_id IN (SELECT id FROM parties WHERE kind = 'supplier');

-- 2. purchase_return party leg (supplier): Cr -> Dr
UPDATE ledger_entries
SET debit = credit, credit = 0
WHERE type = 'purchase_return' AND credit > 0 AND debit = 0
  AND party_id IN (SELECT id FROM parties WHERE kind = 'supplier');

-- 2b. purchase_return inventory leg: Dr -> Cr (goods leave the books)
UPDATE ledger_entries
SET debit = 0, credit = debit
WHERE type = 'inventory_asset' AND reference_type = 'purchase_return'
  AND debit > 0 AND credit = 0;

-- 3. payment_out party leg (supplier): Cr -> Dr
UPDATE ledger_entries
SET debit = credit, credit = 0
WHERE type = 'payment_out' AND credit > 0 AND debit = 0
  AND party_id IN (SELECT id FROM parties WHERE kind = 'supplier');

-- 3b. payment_out cash leg: Dr -> Cr (cash leaves)
UPDATE ledger_entries
SET debit = 0, credit = debit
WHERE type = 'cash' AND reference_type = 'payment_out' AND debit > 0 AND credit = 0;

-- 4. opening party leg (supplier): positive Dr -> Cr
UPDATE ledger_entries
SET debit = 0, credit = debit
WHERE type = 'opening' AND debit > 0 AND credit = 0
  AND party_id IN (SELECT id FROM parties WHERE kind = 'supplier');

-- 4b. opening party leg (supplier): negative Cr -> Dr
UPDATE ledger_entries
SET debit = credit, credit = 0
WHERE type = 'opening' AND credit > 0 AND debit = 0
  AND party_id IN (SELECT id FROM parties WHERE kind = 'supplier');

-- 5. opening_equity contra (reference_id = supplier party): mirror the flips
UPDATE ledger_entries
SET debit = 0, credit = debit
WHERE type = 'opening_equity' AND debit > 0 AND credit = 0
  AND reference_id IN (SELECT id FROM parties WHERE kind = 'supplier');

UPDATE ledger_entries
SET debit = credit, credit = 0
WHERE type = 'opening_equity' AND credit > 0 AND debit = 0
  AND reference_id IN (SELECT id FROM parties WHERE kind = 'supplier');

-- ── Normalize base columns (idempotent; amount/exchange_rate, USD rate = 1) ──
-- Fixes both the fresh flip and the pre-existing party-leg base inversion.
UPDATE ledger_entries
SET base_debit =
      CASE WHEN debit = 0 THEN 0
           ELSE ROUND((debit / NULLIF(COALESCE(exchange_rate, 1), 0))::numeric, 2)
      END,
    base_credit =
      CASE WHEN credit = 0 THEN 0
           ELSE ROUND((credit / NULLIF(COALESCE(exchange_rate, 1), 0))::numeric, 2)
      END
WHERE type IN (
  'purchase_invoice', 'purchase_return', 'inventory_asset',
  'payment_out', 'receipt_in', 'cash', 'opening', 'opening_equity'
)
AND exchange_rate IS NOT NULL;

-- Re-create the append-only trigger (function still exists from 0036b).
CREATE TRIGGER trg_ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION fn_ledger_entries_append_only();

COMMIT;