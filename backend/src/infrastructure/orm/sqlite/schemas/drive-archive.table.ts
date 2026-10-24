/**
 * Google Drive monthly archive runtime tables (migration 0005_drive_archive.sql).
 * Hand-written; they have no PostgreSQL counterpart (motard_* convention — like
 * motard-meta.table.ts). The upload ledger is per-device runtime state, NOT company data:
 * it never enters backups and devices keep their own ledgers, exactly like the sync
 * outbox leases. See the migration header for the idempotency contract.
 */
import { sqliteTable, integer, text } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";

/** Default for TEXT timestamp columns in the STRICT motard_* tables (ISO-8601 string). */
const isoNow = sql`(strftime('%Y-%m-%dT%H:%M:%fZ','now'))`;

/** Cached Drive folder IDs so uploads never re-resolve the hierarchy on every job. */
export const motardDriveFolders = sqliteTable("motard_drive_folders", {
  id: integer("id", { mode: "number" }).primaryKey(),
  kind: text("kind").notNull(), // root | year | month | section
  driveFileId: text("drive_file_id").notNull(),
  parentDriveId: text("parent_drive_id"),
  label: text("label").notNull(),
  /** `YYYY-MM` for month rows, null otherwise. */
  periodKey: text("period_key"),
  /** Last time Drive confirmed this folder still exists (null = never reconciled). */
  verifiedAt: text("verified_at"),
  createdAt: text("created_at").notNull().default(isoNow),
});

/**
 * One archive unit (a document export, a month-close summary, a database backup).
 * `stableKey` makes enqueueing idempotent; `revision` + `contentSha256` make stale
 * content detectable; leases make concurrent workers safe.
 */
export const motardDriveUploads = sqliteTable("motard_drive_uploads", {
  id: text("id").primaryKey(),
  /** sha256(entityType|documentId|periodKey|section|contentSha256) — deterministic. */
  stableKey: text("stable_key").notNull().unique(),
  entityType: text("entity_type").notNull(),
  entityId: text("entity_id").notNull(),
  /**
   * The business document's IMMUTABLE id (the invoice UUID) — the Drive upsert key is derived from
   * it, so renaming a party or cancelling an invoice updates the SAME Drive file instead of
   * creating a second one. NULL on rows written before migration 0008: those rows keep the legacy
   * (file-name-derived) key, so their Drive files are still found.
   */
  documentId: text("document_id"),
  /** The real tenant, so two installations sharing one Google account cannot collide on a key. */
  tenantId: text("tenant_id"),
  periodKey: text("period_key").notNull(),
  section: text("section").notNull(),
  fileName: text("file_name").notNull(),
  mimeType: text("mime_type").notNull(),
  /** Regenerable; nullable — the worker re-exports from source records when null. */
  stagingPath: text("staging_path"),
  contentSha256: text("content_sha256").notNull(),
  /**
   * The hash of the content actually uploaded to Drive. Without it a retried row that already has a
   * `drive_file_id` would be marked done WITHOUT re-uploading, losing the revision (migration 0008).
   */
  uploadedContentSha256: text("uploaded_content_sha256"),
  contentBytes: integer("content_bytes", { mode: "number" }).notNull(),
  /** Bumped when a document is edited after archiving; stale content never wins. */
  revision: integer("revision", { mode: "number" }).notNull().default(1),
  status: text("status").notNull().default("pending"), // pending|uploading|done|failed|blocked
  driveFileId: text("drive_file_id"),
  retryCount: integer("retry_count", { mode: "number" }).notNull().default(0),
  nextAttemptAt: text("next_attempt_at"),
  leaseOwner: text("lease_owner"),
  leaseToken: text("lease_token"),
  leaseUntil: text("lease_until"),
  lastError: text("last_error"),
  deviceId: text("device_id"),
  createdAt: text("created_at").notNull().default(isoNow),
  updatedAt: text("updated_at").notNull().default(isoNow),
  uploadedAt: text("uploaded_at"),
});

/**
 * One render request: the backend asks the shell to turn a document into a PDF or a PNG.
 *
 * The HTML travels in the row — it is produced once, deterministically, by the shared document
 * builders, and the shell renders exactly those bytes.
 */
export const motardDriveRenders = sqliteTable("motard_drive_renders", {
  id: text("id").primaryKey(),
  /** The archive run this artefact belongs to (its staging directory). */
  runId: text("run_id").notNull(),
  /** The business document this is (the invoice id, the cashbox period…). */
  artifactId: text("artifact_id").notNull(),
  format: text("format").notNull(), // pdf | png
  /** The staged file name. */
  outName: text("out_name").notNull(),
  /** A4 | A5, for the PDF page size. */
  paper: text("paper"),
  /** The document to render. */
  html: text("html").notNull(),
  state: text("state").notNull().default("pending"), // pending | rendered | failed
  /** Where the shell staged the rendered file. */
  path: text("path"),
  /** The hash of the staged file, recomputed by the backend before it is uploaded. */
  sha256: text("sha256"),
  sizeBytes: integer("size_bytes", { mode: "number" }),
  error: text("error"),
  createdAt: text("created_at").notNull().default(isoNow),
  updatedAt: text("updated_at").notNull().default(isoNow),
});

/** Bookkeeping for a batch of archive work (documents pass, close, backup upload). */export const motardDriveRuns = sqliteTable("motard_drive_runs", {
  id: text("id").primaryKey(),
  periodKey: text("period_key"),
  kind: text("kind").notNull(), // documents|month_close|db_backup|catchup
  state: text("state").notNull().default("running"), // running|done|failed|partial|cancelled
  /** What started the run: monthly|catchup|manual|connect. */
  trigger: text("trigger").notNull().default("manual"),
  /** Files finished so far (migration 0007). */
  progressDone: integer("progress_done", { mode: "number" }).notNull().default(0),
  /** Files this run will process (migration 0007). */
  progressTotal: integer("progress_total", { mode: "number" }).notNull().default(0),
  /** The file being uploaded right now (migration 0007). */
  currentFile: text("current_file"),
  detail: text("detail"),
  startedAt: text("started_at").notNull().default(isoNow),
  finishedAt: text("finished_at"),
});
