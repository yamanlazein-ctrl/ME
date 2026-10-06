-- 20261021_reconcile_tombstone_schema_drift.sql
-- Reconcile `sync_tombstones` with the two migrations that both create it.
--
-- ── The drift ────────────────────────────────────────────────────────────────
-- `sync_tombstones` has been created TWICE by two different migrations, and the
-- second one is a silent no-op:
--
--   0058_sync_tombstones.sql                  (journal idx 58)
--     id, tenant_id, entity_type, entity_id, deleted_by_device_id,
--     op_id, deletion_seq, created_at
--
--   20260912_batch1_tombstones_conflicts.sql  (journal idx 68)
--     ... plus `deleted_entity_version`, but declared as
--     `CREATE TABLE IF NOT EXISTS` — and by then 0058 had already created the
--     table, so PostgreSQL skipped the whole statement. Its RLS block below the
--     CREATE does run, which is why the table is protected but has a different
--     column set than that migration's text implies.
--
-- Databases that were provisioned by an older, differently-ordered build (or
-- restored from a portable backup taken from one) carry the extra
-- `deleted_entity_version` column. A database created purely from the committed
-- journal does NOT. So the same `restorePortableBackup` run that succeeds on
-- one machine fails on another with:
--
--   RESTORE_FAILED: جدول sync_tombstones لا يطابق الأرشيف
--
-- because portableBackup.ts:655 compares the live column list against the
-- archived one and refuses to write a partial row.
--
-- ── The fix ──────────────────────────────────────────────────────────────────
-- Additive and idempotent: bring the journal-only shape UP to the superset, so
-- every database ends with the same columns. Adding a column with a default is
-- metadata-only in PostgreSQL and rewrites no rows, so this is safe on a live
-- cluster of any size. It never drops a column, so a database that already has
-- it is untouched — the `IF NOT EXISTS` guard makes the statement a no-op there.
--
-- `deleted_entity_version` is the version at deletion time, used for the
-- causality check that stops a stale edit from resurrecting a deleted row. The
-- default of 1 matches 20260912; existing rows are backfilled to 1, which is
-- the conservative value (treated as "version 1 at delete time").

DO $$
BEGIN
  IF to_regclass('public.sync_tombstones') IS NULL THEN
    RAISE EXCEPTION
      'SCHEMA_UNVERIFIED: sync_tombstones is missing — migration 0058 must run first.';
  END IF;
END $$;

ALTER TABLE sync_tombstones
  ADD COLUMN IF NOT EXISTS deleted_entity_version integer NOT NULL DEFAULT 1;

COMMENT ON COLUMN sync_tombstones.deleted_entity_version IS
  'Entity version at deletion time (causality guard). Added by 20261021; '
  '0058 and 20260912 disagreed because 20260912 used CREATE TABLE IF NOT EXISTS '
  'against a table 0058 had already created.';
