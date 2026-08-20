-- Migration: widen ledger_entries.type check constraint
-- Date: 2026-08-20
--
-- The original CHECK only allowed 10 values, but the application writes 20+
-- distinct ledger types (cash, inventory_asset, sales_revenue, etc.). This
-- migration drops the old constraint and recreates it with the complete set
-- defined in backend/src/domain/ledger-entry-type.ts.
--
-- Idempotent: safe to rerun; existing rows are validated but not modified.

ALTER TABLE ledger_entries DROP CONSTRAINT IF EXISTS ledger_entries_type_check;

ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_type_check
  CHECK (type IN (
    'adjustment',
    'adjustment_contra',
    'cancellation',
    'cash',
    'cogs_expense',
    'expense',
    'inventory_asset',
    'opening',
    'opening_equity',
    'payment_out',
    'printing_charge',
    'printing_revenue',
    'purchase_invoice',
    'purchase_return',
    'receipt_in',
    'sales_invoice',
    'sales_revenue',
    'sales_return',
    'settlement',
    'settlement_contra'
  ));
