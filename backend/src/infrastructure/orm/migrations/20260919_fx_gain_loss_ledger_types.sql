-- Allow realized FX gain/loss legs posted when a voucher settles an invoice
-- at a different frozen rate than the invoice. Application types already
-- include fx_gain / fx_loss; the CHECK was never extended, so unequal-rate
-- cross-currency settlement failed at insert (23514).

ALTER TABLE ledger_entries DROP CONSTRAINT IF EXISTS ledger_entries_type_check;

ALTER TABLE ledger_entries ADD CONSTRAINT ledger_entries_type_check
  CHECK (type IN (
    'adjustment',
    'adjustment_contra',
    'cancellation',
    'cash',
    'cogs_expense',
    'expense',
    'fx_gain',
    'fx_loss',
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
