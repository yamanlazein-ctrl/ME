CREATE TABLE IF NOT EXISTS "document_number_blocks" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id"),
  "sync_device_id" uuid NOT NULL REFERENCES "sync_devices"("id"),
  "entity_type" varchar(30) NOT NULL,
  "year" integer NOT NULL,
  "prefix" varchar(10) NOT NULL,
  "start_number" bigint NOT NULL,
  "end_number" bigint NOT NULL,
  "next_number" bigint NOT NULL,
  "status" varchar(20) DEFAULT 'active' NOT NULL,
  "claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  "reclaimed_at" timestamp with time zone
);

CREATE INDEX IF NOT EXISTS "idx_doc_num_blocks_tenant_device_entity"
  ON "document_number_blocks" ("tenant_id", "sync_device_id", "entity_type", "status");

CREATE UNIQUE INDEX IF NOT EXISTS "uq_doc_num_blocks_tenant_entity_year_start"
  ON "document_number_blocks" ("tenant_id", "entity_type", "year", "start_number");

ALTER TABLE "document_number_blocks" ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS document_number_blocks_tenant_isolation ON "document_number_blocks";
CREATE POLICY document_number_blocks_tenant_isolation ON "document_number_blocks"
  USING (
    tenant_id::text = current_setting('app.current_tenant_id', true)
    OR current_setting('app.platform_mode', true) = 'on'
  )
  WITH CHECK (
    tenant_id::text = current_setting('app.current_tenant_id', true)
    OR current_setting('app.platform_mode', true) = 'on'
  );
ALTER TABLE "document_number_blocks" FORCE ROW LEVEL SECURITY;
