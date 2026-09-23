-- REPAIR-027: lease owner/token/until for sync outbox stale-worker protection
ALTER TABLE sync_outbox
  ADD COLUMN IF NOT EXISTS lease_owner text,
  ADD COLUMN IF NOT EXISTS lease_token uuid,
  ADD COLUMN IF NOT EXISTS lease_until timestamptz,
  ADD COLUMN IF NOT EXISTS claimed_at timestamptz;

CREATE INDEX IF NOT EXISTS idx_sync_outbox_lease_until
  ON sync_outbox (tenant_id, lease_until)
  WHERE status = 'pushing';
