-- Migration: fix cash leg sign for payment_out (P0-LOGIC-3.6a)
-- Before fix, both receipt_in and payment_out used debit:amount for cash (inconsistent with expense which correctly credits cash on out).
-- Correct: receipt_in (cash in) is debit cash, payment_out (cash out) is credit cash.
-- Idempotent.

UPDATE ledger_entries
SET debit = 0, credit = debit
WHERE type = 'cash' AND reference_type = 'payment_out' AND debit > 0 AND credit = 0 AND status = 'active';
