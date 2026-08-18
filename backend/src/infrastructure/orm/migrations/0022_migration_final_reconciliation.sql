-- Migration: Final schema reconciliation for production handoff (0022)
-- Closes the remaining drift between the code schema and the migration set:
--   1. print_jobs.receive_notes  (used by PostgresPrintJobRepository / domain / UI)
--   2. schema_migrations table   (drizzle schema migration.table.ts; already present
--                                on existing DBs, but never created by migrations)
-- Both statements are idempotent (IF NOT EXISTS) so this migration is safe on a
-- fresh database AND on an existing one.

-- 1. print_jobs.receive_notes (text)
ALTER TABLE print_jobs ADD COLUMN IF NOT EXISTS receive_notes text;

-- 2. schema_migrations tracking table
CREATE TABLE IF NOT EXISTS schema_migrations (
  version varchar(20) PRIMARY KEY,
  applied_at timestamp with time zone NOT NULL DEFAULT now(),
  applied_by varchar(255),
  description text,
  checksum varchar(64),
  success boolean NOT NULL DEFAULT true
);
