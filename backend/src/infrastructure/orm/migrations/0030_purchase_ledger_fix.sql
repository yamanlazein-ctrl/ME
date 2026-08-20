-- Migration: fix purchase invoice ledger inversion (P0-LOGIC-3.6b)
-- Before fix, purchase invoices were Dr supplier / Cr inventory (inverted).
-- Correct is Dr inventory / Cr supplier. This swaps existing rows.
-- Idempotent: only swaps where debit/credit match the old inverted pattern.

-- Fix party leg: was debit=total, credit=0 for purchase_invoice; should be debit=0, credit=total
UPDATE ledger_entries
SET debit = 0, credit = debit
WHERE type = 'purchase_invoice' AND debit > 0 AND credit = 0 AND status = 'active';

-- Fix inventory leg: was debit=0, credit=total for purchase; should be debit=total, credit=0
UPDATE ledger_entries
SET debit = credit, credit = 0
WHERE type = 'inventory_asset' AND reference_type = 'purchase_invoice' AND debit = 0 AND credit > 0 AND status = 'active';
