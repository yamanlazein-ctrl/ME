-- Pull cursor = order of APPLICATION, not of receipt.
--
-- Bug (reproduced: 450 concurrent sales, 3 PCs): the hub numbers a unit
-- (received_seq) when it RECEIVES it, then applies it. A pull that runs while
-- unit #19 is still being applied sees #20..#444 already applied, moves the
-- device cursor to 444, and #19 — applied a moment later — is never pulled by
-- that device. One invoice silently missing on one PC.
--
-- Fix: every unit gets `applied_seq` the moment it becomes `applied` (any
-- code path: this trigger), taken under a per-tenant advisory lock held until
-- commit. The pull reads by applied_seq under the SAME lock in shared mode, so
-- it can never observe #20 while a lower number is still uncommitted, and a
-- unit applied late simply appears after everything already delivered.
-- Existing rows keep applied_seq = received_seq, so cursors already stored on
-- devices (received_seq values) stay valid — no re-pull on upgrade.
CREATE SEQUENCE IF NOT EXISTS sync_inbox_applied_seq;
--> statement-breakpoint
ALTER TABLE sync_inbox ADD COLUMN IF NOT EXISTS applied_seq bigint;
--> statement-breakpoint
-- sync_inbox has FORCE ROW LEVEL SECURITY: backfill across every tenant in
-- platform mode (transaction-local), like the other cross-tenant maintenance.
DO $$
BEGIN
  PERFORM set_config('app.platform_mode', 'on', true);
  UPDATE sync_inbox SET applied_seq = received_seq WHERE status = 'applied' AND applied_seq IS NULL;
  PERFORM setval('sync_inbox_applied_seq', GREATEST((SELECT COALESCE(max(received_seq), 0) FROM sync_inbox), 1));
END $$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION sync_inbox_stamp_applied_seq() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = 'applied' AND (TG_OP = 'INSERT' OR OLD.status IS DISTINCT FROM 'applied') THEN
    PERFORM pg_advisory_xact_lock(hashtextextended('sync_inbox_applied:' || NEW.tenant_id::text, 0));
    NEW.applied_seq := nextval('sync_inbox_applied_seq');
    NEW.applied_at := COALESCE(NEW.applied_at, clock_timestamp());
  END IF;
  RETURN NEW;
END $$;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_sync_inbox_applied_seq ON sync_inbox;
--> statement-breakpoint
CREATE TRIGGER trg_sync_inbox_applied_seq BEFORE INSERT OR UPDATE OF status ON sync_inbox
  FOR EACH ROW EXECUTE FUNCTION sync_inbox_stamp_applied_seq();
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS idx_sync_inbox_tenant_applied_seq ON sync_inbox (tenant_id, applied_seq) WHERE applied_seq IS NOT NULL;
