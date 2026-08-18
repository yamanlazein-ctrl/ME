-- 0005: License Engine foundation — extend `licenses` & `tenants`, add `system_admins`.
-- Frozen Architecture Specification §3, §6.
--
-- NOTE: drizzle-kit `generate` is intentionally NOT used here. The meta snapshot
-- is already stale relative to the manually-added 0003/0004 migrations, so a
-- generated diff would mis-detect changes. This file is the authoritative DDL
-- and mirrors the Drizzle schema in *.table.ts by hand (same style as 0002/0004).

-- ── System-level Super Admin identity (§2.1, §6) ──────────────────────────
CREATE TABLE "system_admins" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "email" varchar(320) NOT NULL,
  "password_hash" varchar(255) NOT NULL,
  "name" varchar(255),
  "role" varchar(20) DEFAULT 'super_admin' NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE UNIQUE INDEX "idx_system_admins_email" ON "system_admins" USING btree ("email");

-- ── Extend `licenses` (§3) ────────────────────────────────────────────────
ALTER TABLE "licenses" ADD COLUMN IF NOT EXISTS "edition" varchar(32);
ALTER TABLE "licenses" ADD COLUMN IF NOT EXISTS "plan" varchar(32);
ALTER TABLE "licenses" ADD COLUMN IF NOT EXISTS "license_version" varchar(16) DEFAULT 'v1' NOT NULL;
ALTER TABLE "licenses" ADD COLUMN IF NOT EXISTS "product_version" varchar(16);
ALTER TABLE "licenses" ADD COLUMN IF NOT EXISTS "license_model" varchar(16) DEFAULT 'perpetual' NOT NULL;
ALTER TABLE "licenses" ADD COLUMN IF NOT EXISTS "binding_type" varchar(16);
ALTER TABLE "licenses" ADD COLUMN IF NOT EXISTS "binding_value" varchar(255);
ALTER TABLE "licenses" ADD COLUMN IF NOT EXISTS "limits" jsonb DEFAULT '{}' NOT NULL;
ALTER TABLE "licenses" ADD COLUMN IF NOT EXISTS "transfer_policy" jsonb DEFAULT '{"allowed":true,"max_transfers":3,"requires_super_admin":true}' NOT NULL;
ALTER TABLE "licenses" ADD COLUMN IF NOT EXISTS "update_policy" jsonb DEFAULT '{"channel":"stable","allow_updates":true,"minimum_version":"1.0.0"}' NOT NULL;
ALTER TABLE "licenses" ADD COLUMN IF NOT EXISTS "backup_policy" jsonb DEFAULT '{"enabled":true,"cloud_backup":false,"max_backups":30}' NOT NULL;
ALTER TABLE "licenses" ADD COLUMN IF NOT EXISTS "transfers_used" integer DEFAULT 0 NOT NULL;

-- ── Extend `tenants` with denormalized license cache (§6) ──────────────────
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "license_edition" varchar(32);
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "license_plan" varchar(32);
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "license_version" varchar(16) DEFAULT 'v1' NOT NULL;
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "product_version" varchar(16);
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "license_model" varchar(16) DEFAULT 'perpetual' NOT NULL;
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "license_features" text[] DEFAULT '{}' NOT NULL;
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "license_limits" jsonb DEFAULT '{}' NOT NULL;
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "license_binding_type" varchar(16);
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "license_binding_value" varchar(255);
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "transfer_policy" jsonb DEFAULT '{}' NOT NULL;
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "update_policy" jsonb DEFAULT '{}' NOT NULL;
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "backup_policy" jsonb DEFAULT '{}' NOT NULL;
ALTER TABLE "tenants" ADD COLUMN IF NOT EXISTS "transfers_used" integer DEFAULT 0 NOT NULL;

-- Helpful lookup indexes on the new license dimensions.
CREATE INDEX "idx_licenses_edition" ON "licenses" USING btree ("edition");
CREATE INDEX "idx_licenses_plan" ON "licenses" USING btree ("plan");
CREATE INDEX "idx_licenses_license_model" ON "licenses" USING btree ("license_model");
