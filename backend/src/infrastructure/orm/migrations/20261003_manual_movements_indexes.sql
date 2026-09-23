-- REPAIR-005: index manual_movements for cashbox aggregation
CREATE INDEX IF NOT EXISTS idx_manual_movements_tenant_date_currency
  ON manual_movements (tenant_id, date, currency);
CREATE INDEX IF NOT EXISTS idx_manual_movements_tenant_currency_date
  ON manual_movements (tenant_id, currency, date);
