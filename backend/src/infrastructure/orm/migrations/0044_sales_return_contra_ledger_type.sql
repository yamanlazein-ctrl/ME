-- Migration: ensure sales_return_contra (+ purchase_return_contra) in ledger type CHECK
-- Date: 2026-09-07
--
-- PostgresReturnRepository writes type='sales_return_contra' for sale-return
-- revenue contra legs. Migration 0025 omitted that value (and purchase_return_contra).
-- Some environments already widened the CHECK manually; this migration is
-- idempotent: drop + recreate with the full allow-list matching
-- backend/src/domain/ledger-entry-type.ts.

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
    'purchase_return_contra',
    'receipt_in',
    'sales_invoice',
    'sales_revenue',
    'sales_return',
    'sales_return_contra',
    'settlement',
    'settlement_contra'
  ));
