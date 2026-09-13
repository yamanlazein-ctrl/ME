-- P0-001: Add version column to expenses for optimistic concurrency control
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS version integer NOT NULL DEFAULT 1;
ALTER TABLE expenses ADD COLUMN IF NOT EXISTS updated_at timestamptz NOT NULL DEFAULT now();

-- Backfill: set version = 1 for all existing rows (safe default)
-- No action needed as the column defaults to 1

-- Add index for common queries
CREATE INDEX IF NOT EXISTS idx_expenses_tenant_status ON expenses(tenant_id, status);
