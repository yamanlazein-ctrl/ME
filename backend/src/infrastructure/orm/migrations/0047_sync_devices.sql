CREATE TABLE IF NOT EXISTS "sync_devices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "last_seen_by_user_id" uuid REFERENCES "users"("id"),
  "device_fingerprint" varchar(128) NOT NULL,
  "device_fingerprint_version" integer DEFAULT 1 NOT NULL,
  "platform" varchar(16) NOT NULL,
  "hostname" varchar(120),
  "label" varchar(120),
  "last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE INDEX IF NOT EXISTS "idx_sync_devices_tenant" ON "sync_devices" ("tenant_id");
CREATE INDEX IF NOT EXISTS "idx_sync_devices_last_seen_user" ON "sync_devices" ("last_seen_by_user_id");
CREATE UNIQUE INDEX IF NOT EXISTS "uq_sync_devices_tenant_fingerprint"
  ON "sync_devices" ("tenant_id", "device_fingerprint");

ALTER TABLE "sync_devices" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sync_devices_tenant_isolation ON "sync_devices";
CREATE POLICY sync_devices_tenant_isolation ON "sync_devices"
  USING (
    tenant_id::text = current_setting('app.current_tenant_id', true)
    OR current_setting('app.platform_mode', true) = 'on'
  )
  WITH CHECK (
    tenant_id::text = current_setting('app.current_tenant_id', true)
    OR current_setting('app.platform_mode', true) = 'on'
  );

ALTER TABLE "sync_devices" FORCE ROW LEVEL SECURITY;
