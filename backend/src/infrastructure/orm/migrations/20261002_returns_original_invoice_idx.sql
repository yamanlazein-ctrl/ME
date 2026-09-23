-- REPAIR-003: index returns by original invoice (correlated subquery cost)
CREATE INDEX IF NOT EXISTS idx_returns_tenant_original_invoice
  ON returns (tenant_id, original_invoice_id)
  WHERE original_invoice_id IS NOT NULL;
