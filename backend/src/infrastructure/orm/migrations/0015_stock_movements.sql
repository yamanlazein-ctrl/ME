-- 0015_stock_movements.sql
-- Append-only Stock Movement Ledger. Every stock change on a roll (invoice
-- sale/entry, return, print send/receive, manual adjustment) is recorded here
-- atomically inside the same transaction that mutates rolls.remaining_kg.

CREATE TABLE IF NOT EXISTS stock_movements (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  roll_id UUID NOT NULL REFERENCES rolls(id),
  direction VARCHAR(10) NOT NULL CHECK (direction IN ('in', 'out')),
  movement_type VARCHAR(30) NOT NULL,
  quantity_kg DECIMAL(12,2) NOT NULL,
  balance_after_kg DECIMAL(12,2) NOT NULL,
  reference_type VARCHAR(50),
  reference_id UUID,
  reference_number VARCHAR(100),
  movement_date DATE NOT NULL,
  description TEXT,
  status VARCHAR(20) NOT NULL DEFAULT 'active',
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_stock_movements_roll ON stock_movements (tenant_id, roll_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_reference ON stock_movements (tenant_id, reference_type, reference_id);
CREATE INDEX IF NOT EXISTS idx_stock_movements_date ON stock_movements (tenant_id, movement_date);
