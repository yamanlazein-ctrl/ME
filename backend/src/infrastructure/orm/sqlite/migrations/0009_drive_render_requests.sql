-- Google Drive archive: the render-request channel (remediation Stage 3, E-14 / D-11).
--
-- SQLite-only runtime state (motard_* convention — see motard-meta.table.ts): no PostgreSQL
-- counterpart, exactly like migration 0005. Device-bound, so it is excluded from backups.
--
-- WHY A TABLE: the backend owns the archive pipeline and the DOCUMENT data; the shell owns the
-- renderer. Neither can call the other directly — the shell only has an HTTP channel to the
-- backend, so the request is queued here and PULLED by the shell, and the rendered artefact comes
-- back over the same channel. Before this, the backend had no way to ask the shell for anything
-- (`scheduledRunEntry` was declared and never assigned), so the archive could only ever upload
-- CSV: the PDF engine was unreachable from the product.
--
-- The HTML travels in the row: it is produced once, deterministically, and the shell renders
-- exactly those bytes. Re-deriving it on the shell's side would mean a second implementation of
-- the document layout.

CREATE TABLE "motard_drive_renders" (
  "id" TEXT NOT NULL,
  "run_id" TEXT NOT NULL,
  "artifact_id" TEXT NOT NULL,
  "format" TEXT NOT NULL,
  "out_name" TEXT NOT NULL,
  "paper" TEXT,
  "html" TEXT NOT NULL,
  "state" TEXT NOT NULL DEFAULT 'pending',
  "path" TEXT,
  "sha256" TEXT,
  "size_bytes" INTEGER,
  "error" TEXT,
  "created_at" TEXT NOT NULL,
  "updated_at" TEXT NOT NULL,
  CONSTRAINT "motard_drive_renders_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "motard_drive_renders_format" CHECK ("format" IN ('pdf', 'png')),
  CONSTRAINT "motard_drive_renders_state" CHECK ("state" IN ('pending', 'rendered', 'failed'))
) STRICT;

-- The shell pulls the PENDING requests, oldest first.
CREATE INDEX "motard_drive_renders_pending_idx" ON "motard_drive_renders" ("state", "created_at");
