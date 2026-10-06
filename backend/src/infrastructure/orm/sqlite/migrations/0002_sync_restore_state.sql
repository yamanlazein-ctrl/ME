-- T109 (specs/001-desktop-sqlite-engine, OQ-12 / SY-6 / SY-7; owner decision 2026-10-05: option b).
--
-- Restore on a device that already synchronized with a hub. The hub is unchanged: its pull never
-- returns the caller's own units, and it cannot be asked which op-ids it holds. So after such a
-- restore the device takes a NEW sync identity (new sync device id, registered on the hub as a new
-- seat). Under that identity the hub returns everything newer than the restored cursor — including
-- the work this device did after the backup under its previous identity — and the restored outbox
-- units the hub already holds come back by op-id and are acknowledged instead of pushed again.
--
-- SQLite-only runtime state (motard_*): written by the restore (same atomic file swap), advanced by
-- the sync run. One row per database.
CREATE TABLE "motard_sync_restore" (
  "id" INTEGER NOT NULL DEFAULT 1,
  "restored_at" TEXT NOT NULL,
  "generation" INTEGER NOT NULL DEFAULT 1,
  "previous_device_ids" TEXT NOT NULL DEFAULT '[]',
  "new_device_id" TEXT,
  "phase" TEXT NOT NULL,
  "pulled" INTEGER NOT NULL DEFAULT 0,
  "acknowledged" INTEGER NOT NULL DEFAULT 0,
  "last_error" TEXT,
  "updated_at" TEXT NOT NULL,
  CONSTRAINT "motard_sync_restore_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "motard_sync_restore_single_row" CHECK ("id" = 1),
  CONSTRAINT "motard_sync_restore_phase" CHECK ("phase" IN ('register', 'pull', 'done')),
  CONSTRAINT "motard_sync_restore_previous_ids" CHECK (json_valid("previous_device_ids") AND json_type("previous_device_ids") = 'array')
) STRICT;
