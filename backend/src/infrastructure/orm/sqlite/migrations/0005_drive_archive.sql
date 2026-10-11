-- Google Drive monthly archive (plan: .hermes/plans/2026-10-10_151200-google-drive-monthly-archive.md).
--
-- SQLite-only runtime state (motard_* convention — see motard-meta.table.ts): no PostgreSQL
-- counterpart, so the generated-schema pipeline is untouched. Folder/job/manifest state is
-- per-device runtime state: it must survive restarts, but it is NOT company data — the three tables
-- are device-bound in backups (sqliteBackup.ts EXCLUDED_TABLES: emptied in the archive, carried over
-- from the live database on restore), so each device keeps its own upload ledger.
--
-- Idempotency contract: drive_upload_queue.stable_key is a deterministic sha256 of
-- (entity_type | entity_id | period_key | section | content_sha256). Duplicate events from
-- duplicate fires or a second device collapse into the same row (UNIQUE), and a crash after
-- Google accepted the file but before the local status write is recovered from drive_file_id
-- + content hash, never from the filename alone.

CREATE TABLE "motard_drive_folders" (
  "id" INTEGER NOT NULL,
  "kind" TEXT NOT NULL,
  "drive_file_id" TEXT NOT NULL,
  "parent_drive_id" TEXT,
  "label" TEXT NOT NULL,
  "period_key" TEXT,
  "verified_at" TEXT,
  "created_at" TEXT NOT NULL,
  CONSTRAINT "motard_drive_folders_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "motard_drive_folders_kind" CHECK ("kind" IN ('root', 'year', 'month', 'section')),
  CONSTRAINT "motard_drive_folders_period" CHECK ("period_key" IS NULL OR "period_key" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]'),
  CONSTRAINT "motard_drive_folders_unique" UNIQUE ("kind", "parent_drive_id", "label")
) STRICT;

CREATE INDEX "motard_drive_folders_period_idx" ON "motard_drive_folders" ("period_key");

CREATE TABLE "motard_drive_uploads" (
  "id" TEXT NOT NULL,
  "stable_key" TEXT NOT NULL,
  "entity_type" TEXT NOT NULL,
  "entity_id" TEXT NOT NULL,
  "period_key" TEXT NOT NULL,
  "section" TEXT NOT NULL,
  "file_name" TEXT NOT NULL,
  "mime_type" TEXT NOT NULL,
  "staging_path" TEXT,
  "content_sha256" TEXT NOT NULL,
  "content_bytes" INTEGER NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 1,
  "status" TEXT NOT NULL DEFAULT 'pending',
  "drive_file_id" TEXT,
  "retry_count" INTEGER NOT NULL DEFAULT 0,
  "next_attempt_at" TEXT,
  "lease_owner" TEXT,
  "lease_token" TEXT,
  "lease_until" TEXT,
  "last_error" TEXT,
  "device_id" TEXT,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  "uploaded_at" TEXT,
  CONSTRAINT "motard_drive_uploads_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "motard_drive_uploads_stable_key" UNIQUE ("stable_key"),
  CONSTRAINT "motard_drive_uploads_status" CHECK ("status" IN ('pending', 'uploading', 'done', 'failed', 'blocked')),
  CONSTRAINT "motard_drive_uploads_period" CHECK ("period_key" GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]')
) STRICT;

CREATE INDEX "motard_drive_uploads_status_idx" ON "motard_drive_uploads" ("status", "next_attempt_at");
CREATE INDEX "motard_drive_uploads_period_idx" ON "motard_drive_uploads" ("period_key", "section");

CREATE TABLE "motard_drive_runs" (
  "id" TEXT NOT NULL,
  "period_key" TEXT,
  "kind" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'running',
  "detail" TEXT,
  "started_at" TEXT NOT NULL,
  "finished_at" TEXT,
  CONSTRAINT "motard_drive_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "motard_drive_runs_kind" CHECK ("kind" IN ('documents', 'month_close', 'db_backup', 'catchup')),
  CONSTRAINT "motard_drive_runs_state" CHECK ("state" IN ('running', 'done', 'failed', 'partial'))
) STRICT;

CREATE INDEX "motard_drive_runs_period_idx" ON "motard_drive_runs" ("period_key", "kind");
-- PG 20261025_settings_drive_section: the primary-archive-device designation is company
-- data replicated through the hub (settings section drive). Same json_valid CHECK as every sibling
-- settings column: a non-JSON value would otherwise be stored and then throw in JSON.parse on every
-- settings read (orm/sqlite/types.ts jsonb fromDriver).
ALTER TABLE "settings" ADD COLUMN "drive" TEXT DEFAULT '{}' CONSTRAINT "ck_sqlite_json__settings__drive" CHECK ("drive" IS NULL OR (json_valid("drive")));
