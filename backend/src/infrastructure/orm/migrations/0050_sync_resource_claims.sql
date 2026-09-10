CREATE TABLE IF NOT EXISTS "sync_resource_claims" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "resource_type" varchar(40) NOT NULL,
  "resource_id" uuid NOT NULL,
  "claimed_by_op_id" uuid NOT NULL,
  "claimed_by_device_id" uuid REFERENCES "sync_devices"("id"),
  "entity_type" varchar(40) NOT NULL,
  "entity_id" uuid NOT NULL,
  "claimed_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS "uq_sync_resource_claims_tenant_resource"
  ON "sync_resource_claims" ("tenant_id", "resource_type", "resource_id");

CREATE INDEX IF NOT EXISTS "idx_sync_resource_claims_op"
  ON "sync_resource_claims" ("tenant_id", "claimed_by_op_id");

ALTER TABLE "sync_resource_claims" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sync_resource_claims_tenant_isolation ON "sync_resource_claims";
CREATE POLICY sync_resource_claims_tenant_isolation ON "sync_resource_claims"
  USING (
    tenant_id::text = current_setting('app.current_tenant_id', true)
    OR current_setting('app.platform_mode', true) = 'on'
  )
  WITH CHECK (
    tenant_id::text = current_setting('app.current_tenant_id', true)
    OR current_setting('app.platform_mode', true) = 'on'
  );
ALTER TABLE "sync_resource_claims" FORCE ROW LEVEL SECURITY;

ALTER TABLE "sync_inbox"
  ADD COLUMN IF NOT EXISTS "reject_reason" text,
  ADD COLUMN IF NOT EXISTS "conflict_op_id" uuid,
  ADD COLUMN IF NOT EXISTS "conflict_detail" jsonb;
