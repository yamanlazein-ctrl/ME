-- 0014_idempotency_keys.sql
-- Durable idempotency-key store.
-- Redis is the primary cache (5-min TTL); this table is a fallback/durable
-- record so a retried POST with the same Idempotency-Key never double-applies,
-- even across restarts or when Redis is unavailable.

CREATE TABLE IF NOT EXISTS idempotency_keys (
  id BIGSERIAL PRIMARY KEY,
  tenant_id UUID NOT NULL,
  method VARCHAR(10) NOT NULL,
  path TEXT NOT NULL,
  idempotency_key VARCHAR(200) NOT NULL,
  status_code INT NOT NULL,
  response_body JSONB,
  content_type VARCHAR(100) NOT NULL DEFAULT 'application/json; charset=utf-8',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  CONSTRAINT uq_idempotency_scope UNIQUE (tenant_id, method, path, idempotency_key)
);

CREATE INDEX IF NOT EXISTS idx_idempotency_expires ON idempotency_keys (expires_at);