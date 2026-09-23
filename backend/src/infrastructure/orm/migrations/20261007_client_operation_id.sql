-- REPAIR-008 Part B: durable client_operation_id on financial documents
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS client_operation_id uuid;
ALTER TABLE vouchers ADD COLUMN IF NOT EXISTS client_operation_id uuid;
ALTER TABLE returns ADD COLUMN IF NOT EXISTS client_operation_id uuid;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS client_operation_id uuid;
ALTER TABLE manual_movements ADD COLUMN IF NOT EXISTS client_operation_id uuid;
ALTER TABLE ledger_entries ADD COLUMN IF NOT EXISTS client_operation_id uuid;

CREATE UNIQUE INDEX IF NOT EXISTS uq_invoices_tenant_client_op
  ON invoices (tenant_id, client_operation_id) WHERE client_operation_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_vouchers_tenant_client_op
  ON vouchers (tenant_id, client_operation_id) WHERE client_operation_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_returns_tenant_client_op
  ON returns (tenant_id, client_operation_id) WHERE client_operation_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_expenses_tenant_client_op
  ON expenses (tenant_id, client_operation_id) WHERE client_operation_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_manual_movements_tenant_client_op
  ON manual_movements (tenant_id, client_operation_id) WHERE client_operation_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS uq_ledger_entries_tenant_client_op
  ON ledger_entries (tenant_id, client_operation_id) WHERE client_operation_id IS NOT NULL;
