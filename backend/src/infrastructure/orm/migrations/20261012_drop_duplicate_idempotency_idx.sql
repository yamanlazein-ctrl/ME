-- 20261006 added idx_idempotency_keys_expires_at, an exact duplicate of the
-- existing idx_idempotency_expires ON idempotency_keys (expires_at). Keep one.
DROP INDEX IF EXISTS idx_idempotency_keys_expires_at;
