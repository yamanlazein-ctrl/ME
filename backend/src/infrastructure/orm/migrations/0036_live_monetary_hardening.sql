-- Migration: live-database monetary hardening (handoff audit 2026-08-23).
-- The live DB was built schema-sync style and never received migrations
-- 0026 (bigint) / 0013 (hardening). This file documents the applied fix.
--
-- 1) All derived/aggregate money columns real → BIGINT (SYP whole units).
--    Input fields that legitimately accept 2-decimal values go NUMERIC(14,2):
--    invoices.discount/tax/shipping/paid and invoice_lines.discount_amount.
-- 2) ledger_entries immutability: CHECK single-sidedness + append-only
--    trigger (DELETE blocked; UPDATE only status→cancelled).

BEGIN;

-- ── money columns → BIGINT ──────────────────────────────────────────────
ALTER TABLE invoices          ALTER COLUMN subtotal TYPE BIGINT USING subtotal::bigint;
ALTER TABLE invoices          ALTER COLUMN total    TYPE BIGINT USING total::bigint;
ALTER TABLE ledger_entries    ALTER COLUMN debit    TYPE BIGINT USING debit::bigint;
ALTER TABLE ledger_entries    ALTER COLUMN credit   TYPE BIGINT USING credit::bigint;
ALTER TABLE vouchers          ALTER COLUMN amount   TYPE BIGINT USING amount::bigint;
ALTER TABLE expenses          ALTER COLUMN amount   TYPE BIGINT USING amount::bigint;
ALTER TABLE parties           ALTER COLUMN opening_balance        TYPE BIGINT USING opening_balance::bigint;
ALTER TABLE parties           ALTER COLUMN credit_limit           TYPE BIGINT USING credit_limit::bigint;
ALTER TABLE parties           ALTER COLUMN default_discount_amount TYPE BIGINT USING default_discount_amount::bigint;
ALTER TABLE party_balances    ALTER COLUMN balance  TYPE BIGINT USING balance::bigint;
ALTER TABLE cashbox_sessions  ALTER COLUMN opening_balance TYPE BIGINT USING opening_balance::bigint;
ALTER TABLE manual_movements  ALTER COLUMN amount   TYPE BIGINT USING amount::bigint;
ALTER TABLE day_closes        ALTER COLUMN opening_balance TYPE BIGINT USING opening_balance::bigint;
ALTER TABLE day_closes        ALTER COLUMN total_in        TYPE BIGINT USING total_in::bigint;
ALTER TABLE day_closes        ALTER COLUMN total_out       TYPE BIGINT USING total_out::bigint;
ALTER TABLE day_closes        ALTER COLUMN expected        TYPE BIGINT USING expected::bigint;
ALTER TABLE day_closes        ALTER COLUMN counted         TYPE BIGINT USING counted::bigint;
ALTER TABLE day_closes        ALTER COLUMN difference      TYPE BIGINT USING difference::bigint;
ALTER TABLE yearly_party_summaries ALTER COLUMN opening_balance TYPE BIGINT USING opening_balance::bigint;
ALTER TABLE yearly_party_summaries ALTER COLUMN closing_balance TYPE BIGINT USING closing_balance::bigint;
ALTER TABLE yearly_party_summaries ALTER COLUMN total_debit     TYPE BIGINT USING total_debit::bigint;
ALTER TABLE yearly_party_summaries ALTER COLUMN total_credit    TYPE BIGINT USING total_credit::bigint;

-- ── decimal-capable inputs → NUMERIC(14,2) (float eliminated either way) ──
ALTER TABLE invoices      ALTER COLUMN discount TYPE NUMERIC(14,2) USING discount::numeric(14,2);
ALTER TABLE invoices      ALTER COLUMN tax      TYPE NUMERIC(14,2) USING tax::numeric(14,2);
ALTER TABLE invoices      ALTER COLUMN shipping TYPE NUMERIC(14,2) USING shipping::numeric(14,2);
ALTER TABLE invoices      ALTER COLUMN paid     TYPE NUMERIC(14,2) USING paid::numeric(14,2);
ALTER TABLE invoice_lines ALTER COLUMN discount_amount TYPE NUMERIC(14,2) USING discount_amount::numeric(14,2);

COMMIT;
