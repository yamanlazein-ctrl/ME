-- Migration: Convert monetary fields from BIGINT to REAL
-- Date: 2026-08-18
--
-- All monetary fields that previously stored whole units (e.g. 100 = $100)
-- now store floating-point values (e.g. 100.50 = $100.50) to support
-- fractional amounts like 1.5, 2.5, etc.

-- 1. invoices table
ALTER TABLE invoices ALTER COLUMN subtotal TYPE REAL;
ALTER TABLE invoices ALTER COLUMN discount TYPE REAL;
ALTER TABLE invoices ALTER COLUMN tax TYPE REAL;
ALTER TABLE invoices ALTER COLUMN shipping TYPE REAL;
ALTER TABLE invoices ALTER COLUMN total TYPE REAL;
ALTER TABLE invoices ALTER COLUMN paid TYPE REAL;

-- 2. invoice_lines table
ALTER TABLE invoice_lines ALTER COLUMN discount_amount TYPE REAL;

-- 3. ledger_entries table
ALTER TABLE ledger_entries ALTER COLUMN debit TYPE REAL;
ALTER TABLE ledger_entries ALTER COLUMN credit TYPE REAL;

-- 4. vouchers table
ALTER TABLE vouchers ALTER COLUMN amount TYPE REAL;

-- 5. expenses table
ALTER TABLE expenses ALTER COLUMN amount TYPE REAL;

-- 6. parties table
ALTER TABLE parties ALTER COLUMN opening_balance TYPE REAL;
ALTER TABLE parties ALTER COLUMN credit_limit TYPE REAL;
ALTER TABLE parties ALTER COLUMN default_discount_amount TYPE REAL;

-- 7. party_balances table
ALTER TABLE party_balances ALTER COLUMN balance TYPE REAL;

-- 8. yearly_party_summaries table
ALTER TABLE yearly_party_summaries ALTER COLUMN opening_balance TYPE REAL;
ALTER TABLE yearly_party_summaries ALTER COLUMN closing_balance TYPE REAL;
ALTER TABLE yearly_party_summaries ALTER COLUMN total_debit TYPE REAL;
ALTER TABLE yearly_party_summaries ALTER COLUMN total_credit TYPE REAL;

-- 9. cashbox_sessions table
ALTER TABLE cashbox_sessions ALTER COLUMN opening_balance TYPE REAL;

-- 10. manual_movements table
ALTER TABLE manual_movements ALTER COLUMN amount TYPE REAL;

-- 11. day_closes table
ALTER TABLE day_closes ALTER COLUMN opening_balance TYPE REAL;
ALTER TABLE day_closes ALTER COLUMN total_in TYPE REAL;
ALTER TABLE day_closes ALTER COLUMN total_out TYPE REAL;
ALTER TABLE day_closes ALTER COLUMN expected TYPE REAL;
ALTER TABLE day_closes ALTER COLUMN counted TYPE REAL;
ALTER TABLE day_closes ALTER COLUMN difference TYPE REAL;
