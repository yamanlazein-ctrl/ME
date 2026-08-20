-- Migration: convert monetary amounts from REAL to BIGINT (whole units)
-- Date: 2026-08-20
--
-- The previous migrations (0021/0024) used REAL for all money columns, which
-- loses precision above ~2^24. This migration converts every monetary amount
-- to bigint whole units. SYP has no fractional units and the whole codebase
-- treats money as whole integers, so bigint is exact over the full magnitude
-- range and keeps repository code number-typed.
--
-- See docs/money-representation.md for the design decision.
--
-- USING col::bigint makes the migration safe whether the prior type was real
-- or already bigint. Idempotent: rerunning against bigint columns is a no-op.

-- invoices
ALTER TABLE invoices ALTER COLUMN subtotal TYPE BIGINT USING subtotal::BIGINT;
ALTER TABLE invoices ALTER COLUMN discount TYPE BIGINT USING discount::BIGINT;
ALTER TABLE invoices ALTER COLUMN tax TYPE BIGINT USING tax::BIGINT;
ALTER TABLE invoices ALTER COLUMN shipping TYPE BIGINT USING shipping::BIGINT;
ALTER TABLE invoices ALTER COLUMN total TYPE BIGINT USING total::BIGINT;
ALTER TABLE invoices ALTER COLUMN paid TYPE BIGINT USING paid::BIGINT;

-- invoice_lines
ALTER TABLE invoice_lines ALTER COLUMN discount_amount TYPE BIGINT USING discount_amount::BIGINT;

-- ledger_entries
ALTER TABLE ledger_entries ALTER COLUMN debit TYPE BIGINT USING debit::BIGINT;
ALTER TABLE ledger_entries ALTER COLUMN credit TYPE BIGINT USING credit::BIGINT;

-- vouchers
ALTER TABLE vouchers ALTER COLUMN amount TYPE BIGINT USING amount::BIGINT;

-- expenses
ALTER TABLE expenses ALTER COLUMN amount TYPE BIGINT USING amount::BIGINT;

-- parties
ALTER TABLE parties ALTER COLUMN opening_balance TYPE BIGINT USING opening_balance::BIGINT;
ALTER TABLE parties ALTER COLUMN credit_limit TYPE BIGINT USING credit_limit::BIGINT;
ALTER TABLE parties ALTER COLUMN default_discount_amount TYPE BIGINT USING default_discount_amount::BIGINT;

-- party_balances
ALTER TABLE party_balances ALTER COLUMN balance TYPE BIGINT USING balance::BIGINT;

-- yearly_party_summaries
ALTER TABLE yearly_party_summaries ALTER COLUMN opening_balance TYPE BIGINT USING opening_balance::BIGINT;
ALTER TABLE yearly_party_summaries ALTER COLUMN closing_balance TYPE BIGINT USING closing_balance::BIGINT;
ALTER TABLE yearly_party_summaries ALTER COLUMN total_debit TYPE BIGINT USING total_debit::BIGINT;
ALTER TABLE yearly_party_summaries ALTER COLUMN total_credit TYPE BIGINT USING total_credit::BIGINT;

-- cashbox_sessions
ALTER TABLE cashbox_sessions ALTER COLUMN opening_balance TYPE BIGINT USING opening_balance::BIGINT;

-- manual_movements
ALTER TABLE manual_movements ALTER COLUMN amount TYPE BIGINT USING amount::BIGINT;

-- day_closes
ALTER TABLE day_closes ALTER COLUMN opening_balance TYPE BIGINT USING opening_balance::BIGINT;
ALTER TABLE day_closes ALTER COLUMN total_in TYPE BIGINT USING total_in::BIGINT;
ALTER TABLE day_closes ALTER COLUMN total_out TYPE BIGINT USING total_out::BIGINT;
ALTER TABLE day_closes ALTER COLUMN expected TYPE BIGINT USING expected::BIGINT;
ALTER TABLE day_closes ALTER COLUMN counted TYPE BIGINT USING counted::BIGINT;
ALTER TABLE day_closes ALTER COLUMN difference TYPE BIGINT USING difference::BIGINT;