-- Voucher settlement discount + ledger types for double-entry legs.
-- amount = gross party settlement; discount = cash concession (net cash = amount - discount).

ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS discount numeric(14, 2) NOT NULL DEFAULT 0;

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
    'settlement_contra',
    'settlement_discount_expense',
    'settlement_discount_income'
  ));
