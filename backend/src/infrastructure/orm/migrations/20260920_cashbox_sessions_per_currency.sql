-- One cashbox opening-balance session PER CURRENCY, not one per tenant.
-- setOpeningBalance() previously looked up/updated the tenant's single
-- cashbox_sessions row regardless of currency, so setting the USD opening
-- balance overwrote (and lost) the SYP row, and vice versa. No unique index
-- existed to even express "one row per (tenant, currency)". Verified no
-- existing tenant has duplicate (tenant_id, currency) rows before adding
-- this constraint.

CREATE UNIQUE INDEX IF NOT EXISTS idx_cashbox_sessions_tenant_currency
  ON cashbox_sessions (tenant_id, currency);
