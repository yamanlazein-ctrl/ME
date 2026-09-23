-- OLD-PLAN Phase 1: durable financial operation responses (no short TTL)
-- Complements 5-minute idempotency_keys / Redis cache for long-delayed retries.

CREATE TABLE IF NOT EXISTS financial_operations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id),
  method varchar(10) NOT NULL,
  path text NOT NULL,
  operation_key varchar(200) NOT NULL,
  status_code integer NOT NULL,
  response_body jsonb NOT NULL,
  content_type varchar(100) NOT NULL DEFAULT 'application/json; charset=utf-8',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_financial_operations_tenant_op
  ON financial_operations (tenant_id, method, path, operation_key);

CREATE INDEX IF NOT EXISTS idx_financial_operations_tenant_created
  ON financial_operations (tenant_id, created_at);
