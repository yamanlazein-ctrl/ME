CREATE TABLE IF NOT EXISTS "sync_outbox" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "sync_device_id" uuid REFERENCES "sync_devices"("id"),
  "op_id" uuid NOT NULL,
  "entity_type" varchar(40) NOT NULL,
  "entity_id" uuid NOT NULL,
  "operation" varchar(20) NOT NULL,
  "payload" jsonb NOT NULL,
  "status" varchar(20) DEFAULT 'pending' NOT NULL,
  "error_detail" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "synced_at" timestamp with time zone
);

CREATE INDEX IF NOT EXISTS "idx_sync_outbox_tenant_status" ON "sync_outbox" ("tenant_id", "status");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_sync_outbox_tenant_op" ON "sync_outbox" ("tenant_id", "op_id");

ALTER TABLE "sync_outbox" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sync_outbox_tenant_isolation ON "sync_outbox";
CREATE POLICY sync_outbox_tenant_isolation ON "sync_outbox"
  USING (
    tenant_id::text = current_setting('app.current_tenant_id', true)
    OR current_setting('app.platform_mode', true) = 'on'
  )
  WITH CHECK (
    tenant_id::text = current_setting('app.current_tenant_id', true)
    OR current_setting('app.platform_mode', true) = 'on'
  );
ALTER TABLE "sync_outbox" FORCE ROW LEVEL SECURITY;

CREATE TABLE IF NOT EXISTS "sync_inbox" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "sync_device_id" uuid REFERENCES "sync_devices"("id"),
  "op_id" uuid NOT NULL,
  "entity_type" varchar(40) NOT NULL,
  "entity_id" uuid NOT NULL,
  "operation" varchar(20) NOT NULL,
  "payload" jsonb NOT NULL,
  "status" varchar(20) DEFAULT 'received' NOT NULL,
  "received_at" timestamp with time zone DEFAULT now() NOT NULL,
  "applied_at" timestamp with time zone
);

CREATE INDEX IF NOT EXISTS "idx_sync_inbox_tenant" ON "sync_inbox" ("tenant_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_sync_inbox_tenant_op" ON "sync_inbox" ("tenant_id", "op_id");

ALTER TABLE "sync_inbox" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sync_inbox_tenant_isolation ON "sync_inbox";
CREATE POLICY sync_inbox_tenant_isolation ON "sync_inbox"
  USING (
    tenant_id::text = current_setting('app.current_tenant_id', true)
    OR current_setting('app.platform_mode', true) = 'on'
  )
  WITH CHECK (
    tenant_id::text = current_setting('app.current_tenant_id', true)
    OR current_setting('app.platform_mode', true) = 'on'
  );
ALTER TABLE "sync_inbox" FORCE ROW LEVEL SECURITY;
