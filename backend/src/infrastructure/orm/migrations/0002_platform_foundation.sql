CREATE TABLE "company_profiles" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"commercial_reg" varchar(100),
	"tax_number" varchar(100),
	"address" varchar(500),
	"city" varchar(100),
	"country" varchar(100),
	"phone" varchar(30),
	"email" varchar(320),
	"logo_path" varchar(500),
	"currency" varchar(3) DEFAULT 'SYP' NOT NULL,
	"language" varchar(5) DEFAULT 'ar' NOT NULL,
	"fiscal_year_start" date,
	"default_tax_rate" numeric(5, 4) DEFAULT '0.0000' NOT NULL,
	"customization" jsonb DEFAULT '{}',
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "device_registrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"license_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"device_id" uuid NOT NULL,
	"device_fingerprint" varchar(128) NOT NULL,
	"device_fingerprint_version" integer DEFAULT 1 NOT NULL,
	"platform" varchar(16) NOT NULL,
	"name" varchar(100),
	"signed_token" text,
	"signed_token_expires_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	"revoke_reason" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "licenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"key" varchar(64) NOT NULL,
	"type" varchar(20) NOT NULL,
	"status" varchar(20) DEFAULT 'active' NOT NULL,
	"issued_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	"grace_days" integer DEFAULT 7 NOT NULL,
	"max_devices" integer DEFAULT 3 NOT NULL,
	"features" text[] DEFAULT '{}' NOT NULL,
	"vendor_id" varchar(64),
	"vendor_metadata" jsonb,
	"tenant_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "licenses_key_unique" UNIQUE("key")
);
CREATE TABLE "license_activations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"license_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"server_fingerprint" varchar(128) NOT NULL,
	"server_fingerprint_version" integer DEFAULT 1 NOT NULL,
	"hostname" varchar(255),
	"app_version" varchar(32),
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deactivated_at" timestamp with time zone,
	"deactivation_reason" varchar(64),
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "license_audit_events" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"license_id" uuid,
	"tenant_id" uuid,
	"event_type" varchar(50) NOT NULL,
	"payload" jsonb,
	"actor" varchar(255),
	"ip_address" varchar(45),
	"request_id" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "secrets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"key" varchar(128) NOT NULL,
	"ciphertext" text NOT NULL,
	"iv" text NOT NULL,
	"auth_tag" text,
	"algorithm" varchar(32) DEFAULT 'aes-256-gcm' NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"rotated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "server_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"installation_id" uuid NOT NULL,
	"hostname" varchar(255),
	"os" varchar(32),
	"os_version" varchar(64),
	"app_version" varchar(32),
	"last_heartbeat_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE TABLE "setup_wizard_state" (
	"tenant_id" uuid PRIMARY KEY NOT NULL,
	"current_step" varchar(50) DEFAULT 'welcome' NOT NULL,
	"completed_steps" text[] DEFAULT '{}' NOT NULL,
	"is_completed" boolean DEFAULT false NOT NULL,
	"completed_at" timestamp with time zone,
	"data" jsonb DEFAULT '{}',
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
ALTER TABLE "company_profiles" ADD CONSTRAINT "company_profiles_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_registrations" ADD CONSTRAINT "device_registrations_license_id_licenses_id_fk" FOREIGN KEY ("license_id") REFERENCES "public"."licenses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "device_registrations" ADD CONSTRAINT "device_registrations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "licenses" ADD CONSTRAINT "licenses_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "license_activations" ADD CONSTRAINT "license_activations_license_id_licenses_id_fk" FOREIGN KEY ("license_id") REFERENCES "public"."licenses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "license_activations" ADD CONSTRAINT "license_activations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "license_audit_events" ADD CONSTRAINT "license_audit_events_license_id_licenses_id_fk" FOREIGN KEY ("license_id") REFERENCES "public"."licenses"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "license_audit_events" ADD CONSTRAINT "license_audit_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "secrets" ADD CONSTRAINT "secrets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "server_installations" ADD CONSTRAINT "server_installations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "setup_wizard_state" ADD CONSTRAINT "setup_wizard_state_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "idx_company_profiles_tenant" ON "company_profiles" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_device_registrations_license" ON "device_registrations" USING btree ("license_id");--> statement-breakpoint
CREATE INDEX "idx_device_registrations_tenant" ON "device_registrations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_device_registrations_device_id" ON "device_registrations" USING btree ("device_id");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_licenses_key" ON "licenses" USING btree ("key");--> statement-breakpoint
CREATE INDEX "idx_licenses_tenant" ON "licenses" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_licenses_status" ON "licenses" USING btree ("status");--> statement-breakpoint
CREATE INDEX "idx_license_activations_license" ON "license_activations" USING btree ("license_id");--> statement-breakpoint
CREATE INDEX "idx_license_activations_tenant" ON "license_activations" USING btree ("tenant_id");--> statement-breakpoint
CREATE INDEX "idx_license_audit_events_license_created" ON "license_audit_events" USING btree ("license_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_license_audit_events_tenant_created" ON "license_audit_events" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "idx_license_audit_events_event_type" ON "license_audit_events" USING btree ("event_type");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_secrets_tenant_key" ON "secrets" USING btree ("tenant_id","key");--> statement-breakpoint
CREATE UNIQUE INDEX "idx_server_installations_installation_id" ON "server_installations" USING btree ("installation_id");--> statement-breakpoint
CREATE INDEX "idx_server_installations_tenant" ON "server_installations" USING btree ("tenant_id");--> statement-breakpoint

-- ── Extend the existing tenants table with licensing columns ────────────
-- Drizzle's snapshot already includes these (so the diff is empty against
-- the TS schema), but a real DB that applied the original hand-written
-- 0001_initial.sql does NOT have them yet. We add them here explicitly so
-- this migration is the single source of truth for the platform schema.
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "license_status" varchar(20) DEFAULT 'trial' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "license_type" varchar(20) DEFAULT 'trial' NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "max_devices" integer DEFAULT 3 NOT NULL;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "activation_id" uuid;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "server_fingerprint" varchar(128);--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "last_heartbeat_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "idx_tenants_license_status" ON "tenants" USING btree ("license_status");--> statement-breakpoint

-- ════════════════════════════════════════════════════════════════════════
-- RLS (Row Level Security) — Phase 0 sub-batch 0A
-- ════════════════════════════════════════════════════════════════════════
-- Pattern (per the validation report and PLATFORM_FOUNDATION_NOTES.md §2):
--
--   ALTER TABLE <name> ENABLE ROW LEVEL SECURITY;
--   ALTER TABLE <name> FORCE  ROW LEVEL SECURITY;     -- bypass even for owner
--   CREATE POLICY <name>_tenant_isolation ON <name> FOR ALL
--     USING       (tenant_id = current_setting('app.current_tenant_id')::UUID)
--     WITH CHECK  (tenant_id = current_setting('app.current_tenant_id')::UUID);
--
-- The double-quoted identifier <name> in CREATE POLICY must match the
-- current_setting() value the middleware sets via withTenantTx().
--   backend/src/infrastructure/orm/drizzle.ts: withTenantTx
--   backend/src/infrastructure/http/middleware/tenant.middleware.ts (existing)
--
-- Notes for the implementing agent (0A review):
--   * RLS only kicks in when WITH CHECK is present; the original 0001
--     only has USING, so inserts are not constrained on existing tables.
--     That is acceptable for now (out of Phase 0 scope) but the new
--     tables MUST use the full USING + WITH CHECK pattern below.
--   * FORCE RLS is critical because the app connects as the postgres
--     superuser (per DATABASE_URL) and would otherwise bypass RLS.
--   * Two tables (licenses, server_installations, secrets,
--     license_audit_events) can hold rows for a NULL tenant_id
--     (system-level). Their policies use OR tenant_id IS NULL so
--     system-level rows are visible to all tenants for status checks.
--   * setup_wizard_state has 1:1 with tenants and uses a stricter
--     policy (no NULL allowance) — bootstrap is the only path that
--     inserts rows.
-- ════════════════════════════════════════════════════════════════════════

-- licenses: tenant-scoped, but a license can exist before activation
-- (tenant_id IS NULL = unactivated, system-visible to all for status).
ALTER TABLE "licenses" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "licenses" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "licenses_tenant_isolation" ON "licenses" FOR ALL
  USING      ((tenant_id IS NULL) OR (tenant_id = current_setting('app.current_tenant_id', true)::UUID))
  WITH CHECK ((tenant_id IS NULL) OR (tenant_id = current_setting('app.current_tenant_id', true)::UUID));--> statement-breakpoint

-- license_activations: 1 active per license (enforced by partial index below).
ALTER TABLE "license_activations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "license_activations" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "license_activations_tenant_isolation" ON "license_activations" FOR ALL
  USING      (tenant_id = current_setting('app.current_tenant_id', true)::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::UUID);--> statement-breakpoint

-- Partial unique index: one active activation per license.
-- Created here (not in Drizzle) because Drizzle does not support
-- partial indexes declaratively.
CREATE UNIQUE INDEX "idx_license_activations_one_active"
  ON "license_activations" ("license_id")
  WHERE "deactivated_at" IS NULL;--> statement-breakpoint

-- device_registrations: tenant-scoped.
ALTER TABLE "device_registrations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "device_registrations" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "device_registrations_tenant_isolation" ON "device_registrations" FOR ALL
  USING      (tenant_id = current_setting('app.current_tenant_id', true)::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::UUID);--> statement-breakpoint

-- license_audit_events: tenant-scoped, but system-level events
-- (actor='system', no tenant yet) have NULL tenant_id and are visible
-- to all tenants for diagnostic purposes.
ALTER TABLE "license_audit_events" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "license_audit_events" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "license_audit_events_tenant_isolation" ON "license_audit_events" FOR ALL
  USING      ((tenant_id IS NULL) OR (tenant_id = current_setting('app.current_tenant_id', true)::UUID))
  WITH CHECK ((tenant_id IS NULL) OR (tenant_id = current_setting('app.current_tenant_id', true)::UUID));--> statement-breakpoint

-- Append-only trigger: a license_audit_events row, once written, must
-- not be edited or deleted. Enforced at the DB level so even direct
-- pg-client access cannot tamper with the audit log.
CREATE OR REPLACE FUNCTION "fn_license_audit_events_append_only"()
RETURNS TRIGGER AS $$
BEGIN
  RAISE EXCEPTION 'license_audit_events is append-only (operation %)', TG_OP
    USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;--> statement-breakpoint
CREATE TRIGGER "trg_license_audit_events_no_update"
  BEFORE UPDATE ON "license_audit_events"
  FOR EACH ROW EXECUTE FUNCTION "fn_license_audit_events_append_only"();--> statement-breakpoint
CREATE TRIGGER "trg_license_audit_events_no_delete"
  BEFORE DELETE ON "license_audit_events"
  FOR EACH ROW EXECUTE FUNCTION "fn_license_audit_events_append_only"();--> statement-breakpoint

-- secrets: tenant-scoped, system-level secrets (NULL tenant_id) are
-- visible to all (the JWT signing key, the master-key fingerprint, etc.).
ALTER TABLE "secrets" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "secrets" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "secrets_tenant_isolation" ON "secrets" FOR ALL
  USING      ((tenant_id IS NULL) OR (tenant_id = current_setting('app.current_tenant_id', true)::UUID))
  WITH CHECK ((tenant_id IS NULL) OR (tenant_id = current_setting('app.current_tenant_id', true)::UUID));--> statement-breakpoint

-- company_profiles: 1:1 with tenants, strict (no NULL).
ALTER TABLE "company_profiles" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "company_profiles" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "company_profiles_tenant_isolation" ON "company_profiles" FOR ALL
  USING      (tenant_id = current_setting('app.current_tenant_id', true)::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::UUID);--> statement-breakpoint

-- setup_wizard_state: 1:1 with tenants, strict. The only insert path is
-- bootstrap (POST /api/setup/init, sub-batch 0G) which sets the tenant
-- context explicitly before the row is created.
ALTER TABLE "setup_wizard_state" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "setup_wizard_state" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "setup_wizard_state_tenant_isolation" ON "setup_wizard_state" FOR ALL
  USING      (tenant_id = current_setting('app.current_tenant_id', true)::UUID)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::UUID);--> statement-breakpoint

-- server_installations: tenant-scoped, but the first installation
-- row is created during activation (before tenant is established) so
-- it has NULL tenant_id and is system-visible.
ALTER TABLE "server_installations" ENABLE ROW LEVEL SECURITY;--> statement-breakpoint
ALTER TABLE "server_installations" FORCE  ROW LEVEL SECURITY;--> statement-breakpoint
CREATE POLICY "server_installations_tenant_isolation" ON "server_installations" FOR ALL
  USING      ((tenant_id IS NULL) OR (tenant_id = current_setting('app.current_tenant_id', true)::UUID))
  WITH CHECK ((tenant_id IS NULL) OR (tenant_id = current_setting('app.current_tenant_id', true)::UUID));--> statement-breakpoint
