CREATE TABLE IF NOT EXISTS "sync_state" (
  "tenant_id" uuid PRIMARY KEY REFERENCES "tenants"("id"),
  "last_pull_at" timestamp with time zone,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

ALTER TABLE "sync_state" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS sync_state_tenant_isolation ON "sync_state";
CREATE POLICY sync_state_tenant_isolation ON "sync_state"
  USING (
    tenant_id::text = current_setting('app.current_tenant_id', true)
    OR current_setting('app.platform_mode', true) = 'on'
  )
  WITH CHECK (
    tenant_id::text = current_setting('app.current_tenant_id', true)
    OR current_setting('app.platform_mode', true) = 'on'
  );
ALTER TABLE "sync_state" FORCE ROW LEVEL SECURITY;
