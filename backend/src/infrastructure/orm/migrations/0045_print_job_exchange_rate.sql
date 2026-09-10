-- Migration: print_jobs.exchange_rate for receive FX freeze
-- Date: 2026-09-08
-- Issue 11: print-shop receive must capture manual FX when currency ≠ USD
-- (same rule as invoices). Rate = units of document currency per 1 USD.

ALTER TABLE print_jobs
  ADD COLUMN IF NOT EXISTS exchange_rate NUMERIC(18, 6);
