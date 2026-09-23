-- REPAIR-017: device outbox retention helper columns already exist; retention job deletes
-- synced rows older than 90 days where received_seq <= sync_state.last_pull_seq is N/A on device.
-- This migration adds an index to make retention scans cheap.
CREATE INDEX IF NOT EXISTS idx_sync_outbox_synced_at
  ON sync_outbox (tenant_id, synced_at)
  WHERE status = 'synced';
