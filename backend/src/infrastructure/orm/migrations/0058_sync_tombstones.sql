ALTER TABLE "sync_inbox"
  ADD COLUMN IF NOT EXISTS "tombstone_id" uuid;

-- ============================================================
-- 0058_sync_tombstones.sql — Batch 1: tombstone/delete propagation
-- ============================================================
-- Prevents resurrection of deleted master data (fabric/color/roll)
-- after hub replay, restore, or long offline reconnect.
-- The canonical mapping lives in syncMaterialize.ts's
-- ensureTombstoneBeforeMasterMutation; this table is the runtime
-- enforcement for the documented contract.
-- ============================================================

CREATE TABLE IF NOT EXISTS "sync_tombstones" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "entity_type" varchar(40) NOT NULL,
  "entity_id" uuid NOT NULL,
  "deleted_by_device_id" uuid REFERENCES "sync_devices"("id"),
  "op_id" uuid NOT NULL,
  "deletion_seq" bigint NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_sync_tombstones_tenant_entity"
  ON "sync_tombstones" ("tenant_id", "entity_type", "entity_id");

ALTER TABLE "sync_tombstones" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sync_tombstones_tenant_isolation ON "sync_tombstones";
CREATE POLICY sync_tombstones_tenant_isolation ON "sync_tombstones"
  USING (
    tenant_id::text = current_setting('app.current_tenant_id', true)
    OR current_setting('app.platform_mode', true) = 'on'
  )
  WITH CHECK (
    tenant_id::text = current_setting('app.current_tenant_id', true)
    OR current_setting('app.platform_mode', true) = 'on'
  );
ALTER TABLE "sync_tombstones" FORCE ROW LEVEL SECURITY;

CREATE INDEX IF NOT EXISTS "idx_sync_tombstones_tenant_type"
  ON "sync_tombstones" ("tenant_id", "entity_type");
