-- Google Drive archive run metadata (remediation Stage 1: B-01, B-02, I-04).
--
-- SQLite-only runtime state (motard_* convention — see motard-meta.table.ts): there is NO
-- PostgreSQL counterpart, exactly like migration 0005. The PG schema is untouched, and the
-- generated-schema pipeline (scripts/generate-sqlite-schema.mts) lists motard_drive_runs as
-- HAND_WRITTEN, so this file stays hand-maintained.
--
-- 1) The state CHECK must accept 'cancelled'. archiveRuns.ts has always been able to produce it
--    (finalState(): a user-cancelled run ends as 'cancelled'), but the CHECK rejected it. The
--    UPDATE then threw, the caller caught it, rewrote the run as 'failed' and rethrew — so the
--    cancel route answered HTTP 500 and a deliberate user cancellation was recorded in the run
--    history as a failure. The CHECK was the thing out of step with the state machine.
--
-- 2) SQLite cannot ALTER a CHECK constraint in place, so the table is rebuilt: create the new
--    shape, copy every row, drop the old table, rename. DROP TABLE takes the table's indexes
--    with it, so the period index is recreated afterwards. No trigger or view references this
--    table (verified), so the rename is safe with foreign_keys = ON.
--
-- 3) The run metadata columns the plan asked for (PLAN.md:367). They are additive and start
--    empty/defaulted; Stage 2 populates them, because the run route does not yet accept a body
--    and therefore cannot know the trigger or the period. 'manual' is the only trigger the
--    current code can actually produce (driveArchiveWiring.syncNow -> runArchivePass "manual"),
--    so it is the correct backfill for every row that exists today.

CREATE TABLE "motard_drive_runs_new" (
  "id" TEXT NOT NULL,
  "period_key" TEXT,
  "kind" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'running',
  "trigger" TEXT NOT NULL DEFAULT 'manual',
  "progress_done" INTEGER NOT NULL DEFAULT 0,
  "progress_total" INTEGER NOT NULL DEFAULT 0,
  "current_file" TEXT,
  "detail" TEXT,
  "started_at" TEXT NOT NULL,
  "finished_at" TEXT,
  CONSTRAINT "motard_drive_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "motard_drive_runs_kind" CHECK ("kind" IN ('documents', 'month_close', 'db_backup', 'catchup')),
  CONSTRAINT "motard_drive_runs_state" CHECK ("state" IN ('running', 'done', 'failed', 'partial', 'cancelled'))
) STRICT;

INSERT INTO "motard_drive_runs_new" (
  "id", "period_key", "kind", "state", "trigger", "progress_done", "progress_total",
  "current_file", "detail", "started_at", "finished_at"
)
SELECT
  "id", "period_key", "kind", "state", 'manual', 0, 0, NULL, "detail", "started_at", "finished_at"
FROM "motard_drive_runs";

DROP TABLE "motard_drive_runs";

ALTER TABLE "motard_drive_runs_new" RENAME TO "motard_drive_runs";

CREATE INDEX "motard_drive_runs_period_idx" ON "motard_drive_runs" ("period_key", "kind");
