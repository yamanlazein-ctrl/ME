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
-- The ledger is append-only (0036b): this migration temporarily drops that
-- trigger, applies the two PARTs below, then re-creates it.
--
-- This file contains TWO INDEPENDENT, separately-reviewable/retrievable parts
-- kept in the same transaction only for convenience of the append-only
-- trigger. They are orthogonal and can be split into two migrations later
-- without losing correctness:
--
--   PART A — flip the RAW debit/credit DIRECTION of historical supplier rows
--            (the double-entry convention change itself).
--   PART B — NORMALIZE base_debit/base_credit from the raw columns
--            (fixes the pre-existing base-column inversion, e.g. legacy rows
--            that stored the USD equivalent in base_credit for a raw debit).
--
-- Reverting PART A alone is not meaningful without also reverting the code in
-- PostgresInvoice/Return/Voucher/Party/Statement/Ledger repositories, because
-- the read path (supplier = credit − debit) now assumes the standard direction.
-- Reverting PART B alone only affects USD-equivalent aggregation columns; the
-- raw double-entry balance and the supplier statement are unaffected by it.

BEGIN;

DROP TRIGGER IF EXISTS trg_ledger_entries_append_only ON ledger_entries;

-- ═══════════════════════════════════════════════════════════════════════════
-- PART A — flip raw debit/credit direction (idempotent: matches ONLY the OLD
-- direction, so a re-run flips 0 rows). This is the convention change itself:
-- supplier "owed" moves from the debit side to the credit side.
-- ═══════════════════════════════════════════════════════════════════════════

-- A1. purchase_invoice party leg (supplier): Dr -> Cr
UPDATE ledger_entries
SET debit = 0, credit = debit
WHERE type = 'purchase_invoice' AND debit > 0 AND credit = 0
  AND party_id IN (SELECT id FROM parties WHERE kind = 'supplier');

-- A2. purchase_return party leg (supplier): Cr -> Dr
UPDATE ledger_entries
SET debit = credit, credit = 0
WHERE type = 'purchase_return' AND credit > 0 AND debit = 0
  AND party_id IN (SELECT id FROM parties WHERE kind = 'supplier');

-- A2b. purchase_return inventory leg: Dr -> Cr (goods leave the books)
UPDATE ledger_entries
SET debit = 0, credit = debit
WHERE type = 'inventory_asset' AND reference_type = 'purchase_return'
  AND debit > 0 AND credit = 0;

-- A3. payment_out party leg (supplier): Cr -> Dr
UPDATE ledger_entries
SET debit = credit, credit = 0
WHERE type = 'payment_out' AND credit > 0 AND debit = 0
  AND party_id IN (SELECT id FROM parties WHERE kind = 'supplier');

-- A3b. payment_out cash leg: Dr -> Cr (cash leaves)
UPDATE ledger_entries
SET debit = 0, credit = debit
WHERE type = 'cash' AND reference_type = 'payment_out' AND debit > 0 AND credit = 0;

-- A4. opening party leg (supplier): positive Dr -> Cr
UPDATE ledger_entries
SET debit = 0, credit = debit
WHERE type = 'opening' AND debit > 0 AND credit = 0
  AND party_id IN (SELECT id FROM parties WHERE kind = 'supplier');

-- A4b. opening party leg (supplier): negative Cr -> Dr
UPDATE ledger_entries
SET debit = credit, credit = 0
WHERE type = 'opening' AND credit > 0 AND debit = 0
  AND party_id IN (SELECT id FROM parties WHERE kind = 'supplier');

-- A5. opening_equity contra (reference_id = supplier party): mirror the flips
UPDATE ledger_entries
SET debit = 0, credit = debit
WHERE type = 'opening_equity' AND debit > 0 AND credit = 0
  AND reference_id IN (SELECT id FROM parties WHERE kind = 'supplier');

UPDATE ledger_entries
SET debit = credit, credit = 0
WHERE type = 'opening_equity' AND credit > 0 AND debit = 0
  AND reference_id IN (SELECT id FROM parties WHERE kind = 'supplier');

-- ═══════════════════════════════════════════════════════════════════════════
-- PART B — normalize base columns (idempotent; amount/exchange_rate, USD rate
-- = 1). Independent of PART A: it recomputes base_debit/base_credit from the
-- CURRENT raw debit/credit of each affected leg, so it produces the correct
-- result whether or not PART A has run. It also repairs the pre-existing
-- inversion where legacy purchase_invoice party legs stored the USD equivalent
-- in base_credit for a raw debit (introduced by the BUG-3 raw-direction flip
-- e25fcd0, whose legFx() call was not updated; later fixed for new writes in
-- a66eef8). Does NOT touch raw debit/credit.
-- ═══════════════════════════════════════════════════════════════════════════
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