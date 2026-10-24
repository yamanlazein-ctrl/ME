-- Google Drive archive: immutable document identity (remediation Stage 2: C-01, C-02, C-03, C-05).
--
-- SQLite-only runtime state (motard_* convention — see motard-meta.table.ts): no PostgreSQL
-- counterpart, exactly like migration 0005. The PG schema is untouched, and the generated-schema
-- pipeline (scripts/generate-sqlite-schema.mts) lists motard_drive_* as HAND_WRITTEN.
--
-- WHY: the Drive upsert key (appProperties.motardKey) was derived from the FILE NAME, i.e. from
-- mutable business fields (date, number, party, the cancelled marker). Renaming a party, cancelling
-- an invoice or renumbering it therefore produced a NEW key → a NEW Drive file, and the old file
-- stayed behind as an orphan. Two invoices that happened to share date+number+party produced the
-- SAME file name → the SAME key → one of them was silently lost.
--
-- The key is now derived from the business document's immutable id (the invoice UUID). Three columns
-- make that possible and keep every step reproducible from the row alone:
--
--   document_id             the immutable business document id (invoice UUID). NULL on rows written
--                           before this migration — those rows keep the legacy key, so their Drive
--                           files are still found (see uploadQueue.documentKey).
--   tenant_id               the real tenant, so two installations sharing one Google account cannot
--                           produce the same key. Backfilled from the single settings row.
--   uploaded_content_sha256 the hash of the content actually uploaded. Without it a retried row
--                           that already has a drive_file_id would be marked DONE without re-uploading
--                           the new content (a revision would be lost). The pre-migration rows have
--                           no such column, so their value is unknown; they are treated as "unknown"
--                           and re-uploaded once, which is safe: the upsert updates the same file.
--
-- The stable_key of existing rows is NOT rewritten here. The queue adopts a legacy row in place when
-- it recognises the document (same entity_type + entity_id + period_key + section), which keeps the
-- row's drive_file_id and therefore the same Drive file. Rewriting the keys in SQL would need the
-- content hash, which is exactly what the stable_key already encodes.

ALTER TABLE "motard_drive_uploads" ADD COLUMN "document_id" TEXT;
ALTER TABLE "motard_drive_uploads" ADD COLUMN "tenant_id" TEXT;
ALTER TABLE "motard_drive_uploads" ADD COLUMN "uploaded_content_sha256" TEXT;

-- The desktop holds exactly one tenant (its settings row). Backfill the tenant so every row that
-- existed before this migration still carries the real one in its key.
UPDATE "motard_drive_uploads"
   SET "tenant_id" = (SELECT "tenant_id" FROM "settings" ORDER BY "id" LIMIT 1)
 WHERE "tenant_id" IS NULL;

-- The document lookup used when a legacy row is recognised and adopted.
CREATE INDEX "motard_drive_uploads_document_idx" ON "motard_drive_uploads" ("document_id", "section");
-- The legacy-identity lookup (entity_type + entity_id + period_key + section).
CREATE INDEX "motard_drive_uploads_legacy_identity_idx"
  ON "motard_drive_uploads" ("entity_type", "entity_id", "period_key", "section");
