-- Sync protocol hardening: monotonic ordering + visible failure state.
--
-- Why this exists:
--   * `created_at` / `received_at` default to now(), which is TRANSACTION START
--     time in PostgreSQL. Rows written in one transaction therefore share an
--     identical timestamp, so neither column can be used as a pagination cursor
--     or as a stable sort key. Both are replaced by a real monotonic sequence.
--   * A unit whose materialization keeps failing stayed `received` forever with
--     no attempt counter and no operator visibility. `apply_attempts` +
--     `materialize_error` make that state observable and bounded.
--   * `setMaterializeError` previously wrote into `conflict_detail`, clobbering
--     the conflict provenance of the row. It now has its own column.

ALTER TABLE "sync_outbox" ADD COLUMN IF NOT EXISTS "seq" bigserial;

ALTER TABLE "sync_inbox" ADD COLUMN IF NOT EXISTS "received_seq" bigserial;
ALTER TABLE "sync_inbox" ADD COLUMN IF NOT EXISTS "materialize_error" jsonb;
ALTER TABLE "sync_inbox" ADD COLUMN IF NOT EXISTS "apply_attempts" integer DEFAULT 0 NOT NULL;
ALTER TABLE "sync_inbox" ADD COLUMN IF NOT EXISTS "last_attempt_at" timestamp with time zone;

CREATE INDEX IF NOT EXISTS "idx_sync_outbox_tenant_status_seq"
  ON "sync_outbox" ("tenant_id", "status", "seq");

CREATE INDEX IF NOT EXISTS "idx_sync_inbox_tenant_status_received_seq"
  ON "sync_inbox" ("tenant_id", "status", "received_seq");

CREATE INDEX IF NOT EXISTS "idx_sync_inbox_tenant_device_received_seq"
  ON "sync_inbox" ("tenant_id", "sync_device_id", "received_seq");

-- Pull cursor. `last_pull_at` (a timestamp) is kept for display/back-compat but
-- is no longer used for pagination: a wall-clock cursor cannot express
-- "everything after this exact row".
ALTER TABLE "sync_state" ADD COLUMN IF NOT EXISTS "last_pull_seq" bigint;
