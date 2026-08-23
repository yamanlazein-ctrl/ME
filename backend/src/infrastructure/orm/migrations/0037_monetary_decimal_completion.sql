-- Migration: monetary decimal completion (QA decimal-fraction audit 2026-08-23).
--
-- Completes migration 0036's direction: 0036 converted the *input* money
-- columns (invoices.discount/tax/shipping/paid, invoice_lines.discount_amount)
-- to NUMERIC(14,2) but left every *derived/aggregate* column (invoices.subtotal
-- /total, ledger legs, vouchers, expenses, balances) as BIGINT whole units.
-- The mixed state rejects fractional USD amounts at INSERT with SQLSTATE 22P02
-- ("invalid input syntax for type bigint") — e.g. invoice discount 0.5$ makes
-- total = subtotal - 0.5 fractional and the insert fails.
--
-- This migration converts ALL monetary columns to NUMERIC(14,2) so cents are
-- stored exactly for USD/EUR (SYP values are unaffected: they stay x.00).
-- Idempotent: re-running ALTER TYPE to the same type is a no-op.
--
-- Companion code change: per-line rounding switched from Math.round (whole
-- units) to round2dp (2 decimals) so computed totals keep their cents.

BEGIN;

-- ── invoices ─────────────────────────────────────────────────────────────
ALTER TABLE invoices      ALTER COLUMN subtotal TYPE NUMERIC(14,2) USING subtotal::numeric(14,2);
ALTER TABLE invoices      ALTER COLUMN discount TYPE NUMERIC(14,2) USING discount::numeric(14,2);
ALTER TABLE invoices      ALTER COLUMN tax      TYPE NUMERIC(14,2) USING tax::numeric(14,2);
ALTER TABLE invoices      ALTER COLUMN shipping TYPE NUMERIC(14,2) USING shipping::numeric(14,2);
ALTER TABLE invoices      ALTER COLUMN total    TYPE NUMERIC(14,2) USING total::numeric(14,2);
ALTER TABLE invoices      ALTER COLUMN paid     TYPE NUMERIC(14,2) USING paid::numeric(14,2);
ALTER TABLE invoice_lines ALTER COLUMN discount_amount TYPE NUMERIC(14,2) USING discount_amount::numeric(14,2);

-- ── double-entry ledger ──────────────────────────────────────────────────
ALTER TABLE ledger_entries       ALTER COLUMN debit  TYPE NUMERIC(14,2) USING debit::numeric(14,2);
ALTER TABLE ledger_entries       ALTER COLUMN credit TYPE NUMERIC(14,2) USING credit::numeric(14,2);
ALTER TABLE ledger_entry_archive ALTER COLUMN debit  TYPE NUMERIC(14,2) USING debit::numeric(14,2);
ALTER TABLE ledger_entry_archive ALTER COLUMN credit TYPE NUMERIC(14,2) USING credit::numeric(14,2);

-- ── vouchers / expenses ──────────────────────────────────────────────────
ALTER TABLE vouchers ALTER COLUMN amount TYPE NUMERIC(14,2) USING amount::numeric(14,2);
ALTER TABLE expenses ALTER COLUMN amount TYPE NUMERIC(14,2) USING amount::numeric(14,2);

-- ── parties ──────────────────────────────────────────────────────────────
ALTER TABLE parties ALTER COLUMN opening_balance         TYPE NUMERIC(14,2) USING opening_balance::numeric(14,2);
ALTER TABLE parties ALTER COLUMN credit_limit            TYPE NUMERIC(14,2) USING credit_limit::numeric(14,2);
ALTER TABLE parties ALTER COLUMN default_discount_amount TYPE NUMERIC(14,2) USING default_discount_amount::numeric(14,2);

-- ── cashbox ──────────────────────────────────────────────────────────────
ALTER TABLE cashbox_sessions  ALTER COLUMN opening_balance TYPE NUMERIC(14,2) USING opening_balance::numeric(14,2);
ALTER TABLE manual_movements  ALTER COLUMN amount          TYPE NUMERIC(14,2) USING amount::numeric(14,2);
ALTER TABLE day_closes        ALTER COLUMN opening_balance TYPE NUMERIC(14,2) USING opening_balance::numeric(14,2);
ALTER TABLE day_closes        ALTER COLUMN total_in        TYPE NUMERIC(14,2) USING total_in::numeric(14,2);
ALTER TABLE day_closes        ALTER COLUMN total_out       TYPE NUMERIC(14,2) USING total_out::numeric(14,2);
ALTER TABLE day_closes        ALTER COLUMN expected        TYPE NUMERIC(14,2) USING expected::numeric(14,2);
ALTER TABLE day_closes        ALTER COLUMN counted         TYPE NUMERIC(14,2) USING counted::numeric(14,2);
ALTER TABLE day_closes        ALTER COLUMN difference      TYPE NUMERIC(14,2) USING difference::numeric(14,2);

-- ── yearly party summaries ───────────────────────────────────────────────
ALTER TABLE yearly_party_summaries ALTER COLUMN opening_balance TYPE NUMERIC(14,2) USING opening_balance::numeric(14,2);
ALTER TABLE yearly_party_summaries ALTER COLUMN closing_balance TYPE NUMERIC(14,2) USING closing_balance::numeric(14,2);
ALTER TABLE yearly_party_summaries ALTER COLUMN total_debit     TYPE NUMERIC(14,2) USING total_debit::numeric(14,2);
ALTER TABLE yearly_party_summaries ALTER COLUMN total_credit    TYPE NUMERIC(14,2) USING total_credit::numeric(14,2);

-- ── optional balance cache (created by migration 0020; may not exist) ────
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'party_balances') THEN
    EXECUTE 'ALTER TABLE party_balances ALTER COLUMN balance TYPE NUMERIC(14,2) USING balance::numeric(14,2)';
  END IF;
END $$;

COMMIT;
