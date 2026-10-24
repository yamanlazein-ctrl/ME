/**
 * Upload queue: durable, idempotent, restart-safe.
 *
 * - `enqueue` is deterministic on stableKey → duplicate events are no-ops.
 * - The worker claims one row with a lease (expired leases reclaimable),
 *   uploads, verifies, then marks done. A crash after Google accepted the
 *   file but before the local write is reconciled by Drive file id, not by
 *   filename.
 * - Business-date assignment happens at enqueue time (`periodKey`), never at
 *   upload time, so retries keep the correct month.
 */
import { createHash, randomUUID } from "node:crypto";
import { and, asc, desc, eq, isNull, lte, or, sql } from "drizzle-orm";
import { appKey } from "@erp/shared";
import { motardDriveUploads } from "../orm/sqlite/schemas/drive-archive.table.js";
import type { DriveClient, DriveFileMeta } from "./driveClient.js";
import { DriveAuthError, DriveError } from "./driveClient.js";
import type { FolderOrganizer } from "./folderOrganizer.js";
import { categoryOfSection } from "./archiveCore.js";
import type { DB } from "../orm/sqlite/drizzleCompat.js";

export type EnqueueInput = {
  entityType: string;
  /** The locator: the file name for a document, the file PATH for a backup on disk. */
  entityId: string;
  /**
   * The business document's IMMUTABLE id (the invoice UUID). The Drive upsert key is derived from
   * it, so the document is found and updated in place when it is renamed, cancelled or renumbered.
   */
  documentId: string;
  /** The real tenant — two installations sharing one Google account must not collide on a key. */
  tenantId: string;
  /**
   * The file-name prefix this document had before the upgrade (`${date}_${number}_`), used ONCE to
   * recognise a queue row written before migration 0008 and adopt it in place — which keeps that
   * row's `drive_file_id`, and therefore the same Drive file. Null when the document has no legacy
   * name (a database backup is a new timestamped archive every time).
   */
  legacyNamePrefix?: string | null;
  businessDate: string; // YYYY-MM-DD
  section: string;
  fileName: string;
  mimeType: string;
  content: Uint8Array | string;
  deviceId: string;
};

/**
 * Phase 4: an archive file that stays ON DISK. The queue records its size and SHA-256, computed by
 * streaming the file, so a large backup is never loaded into memory.
 */
export type EnqueueFileInput = Omit<EnqueueInput, "content"> & { filePath: string };

/** SHA-256 and size of a file, computed by streaming it (memory use is constant, not the file size). */
export async function hashFileStreaming(
  filePath: string,
): Promise<{ sha256: string; size: number }> {
  const { digest, size } = await digestFile(filePath, "sha256");
  return { sha256: digest, size };
}

/** MD5 of a file, streamed — Drive reports `md5Checksum` for what it stored. */
async function md5OfFile(filePath: string): Promise<string> {
  return (await digestFile(filePath, "md5")).digest;
}

async function digestFile(
  filePath: string,
  algorithm: "sha256" | "md5",
): Promise<{ digest: string; size: number }> {
  const { createReadStream } = await import("node:fs");
  const hash = createHash(algorithm);
  let size = 0;
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(filePath);
    stream.on("data", (chunk: Buffer | string) => {
      const buf = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
      size += buf.length;
      hash.update(buf);
    });
    stream.on("end", () => resolve());
    stream.on("error", reject);
  });
  return { digest: hash.digest("hex"), size };
}

const LEASE_MS = 5 * 60 * 1000;
/** Drive's multipart upload limit; larger files (database backups) go through a resumable session. */
const SMALL_UPLOAD_MAX = 5 * 1024 * 1024;
const MAX_RETRIES = 8;

function nowIso(): string {
  return new Date().toISOString();
}

function toIso(d: Date): string {
  return d.toISOString();
}

/** `text` as a GLOB pattern that matches only itself. */
export function globLiteral(text: string): string {
  return text.replace(/[*?[]/g, (c) => `[${c}]`);
}

function contentOf(c: Uint8Array | string): Uint8Array {
  return typeof c === "string" ? new TextEncoder().encode(c) : c;
}

/**
 * The Drive upsert key for a queued document.
 *
 * Built from the business document's IMMUTABLE id, so the same document always maps to the same
 * Drive file — a renamed party, a cancelled invoice or a renumbered invoice updates that file
 * instead of creating a second one.
 *
 * A row written before migration 0008 has no `documentId`; it keeps the LEGACY key (derived from
 * the file name) so the Drive file it already uploaded is still found and adopted.
 */
export function documentKey(
  job: Pick<
    ClaimedJob,
    "tenantId" | "entityType" | "entityId" | "periodKey" | "section" | "documentId"
  >,
): string {
  if (!job.documentId) return legacyDocumentKey(job);
  return appKey({
    tenantId: job.tenantId,
    docType: `${job.section}:${job.entityType}`,
    documentId: job.documentId,
  });
}

/**
 * The key of a queue row written before migration 0008 (no document id): derived from the FILE NAME,
 * with the tenant hard-coded to "archive". It only names the Drive file such a row uploads now —
 * no file uploaded by 3.0.6 carries ANY key (that version set no `appProperties`); those files are
 * adopted by their id instead (see `findExistingFile`).
 */
export function legacyDocumentKey(
  job: Pick<ClaimedJob, "entityType" | "entityId" | "periodKey" | "section">,
): string {
  return appKey({
    tenantId: "archive",
    docType: `${job.section}:${job.entityType}`,
    documentId: `${job.periodKey}:${job.entityId}`,
  });
}

/**
 * The idempotency key of a queue row: the document's identity plus the hash of its content. The
 * same document with the same content collapses into ONE row; changed content is a new revision.
 *
 * The identity part is the IMMUTABLE document id, not the file name: two invoices that happened to
 * share date+number+party produced the same file name and therefore the same key, and one of them
 * was silently lost.
 */
export function stableKeyOfParts(
  entityType: string,
  documentId: string,
  periodKey: string,
  section: string,
  contentSha256: string,
): string {
  return [entityType, documentId, periodKey, section, contentSha256].join("|");
}

export class UploadQueue {
  constructor(
    private readonly db: DB,
    private readonly drive: DriveClient,
    private readonly folders: FolderOrganizer,
  ) {}

  /**
   * Enqueue one archive unit. Idempotent: the same (document, content-hash) collapses into the
   * existing row; changed content bumps the revision and enqueues fresh work. Never throws on Drive
   * problems — the queue is local state.
   *
   * A row written BEFORE migration 0008 carried a file-name-derived key. Such a row is recognised
   * and ADOPTED in place (same row id, same `drive_file_id`) so the document keeps the Drive file it
   * already has instead of getting a second one.
   */
  async enqueue(input: EnqueueInput): Promise<{ id: string; deduped: boolean }> {
    const content = contentOf(input.content);
    const sha = createHash("sha256").update(content).digest("hex");
    const periodKey = input.businessDate.slice(0, 7);
    const stableKey = stableKeyOfParts(
      input.entityType,
      input.documentId,
      periodKey,
      input.section,
      sha,
    );

    // 1. The normal path: this document with this exact content is already queued.
    const [existing] = await this.db
      .select()
      .from(motardDriveUploads)
      .where(eq(motardDriveUploads.stableKey, stableKey))
      .limit(1);
    if (existing) {
      if (existing.status === "done") return { id: existing.id, deduped: true };
      // Same content re-queued while still pending/failed: revive the row.
      await this.db
        .update(motardDriveUploads)
        .set({ status: "pending", nextAttemptAt: null, lastError: null, updatedAt: nowIso() })
        .where(eq(motardDriveUploads.id, existing.id));
      return { id: existing.id, deduped: true };
    }

    // 2. A row written before migration 0008: its key was built from the FILE NAME. Adopt it so the
    //    row — and the Drive file it points at — survives.
    const legacy = await this.findAdoptableRow(input, periodKey);
    if (legacy) {
      if (legacy.contentSha256 === sha) {
        // Identical content: the Drive file already holds it. Only the identity is filled in.
        await this.db
          .update(motardDriveUploads)
          .set({ documentId: input.documentId, tenantId: input.tenantId, updatedAt: nowIso() })
          .where(eq(motardDriveUploads.id, legacy.id));
        return { id: legacy.id, deduped: true };
      }
      // The document changed: the SAME row becomes the new revision, so its `drive_file_id` survives
      // and the upload replaces the content of that file instead of creating a second one.
      await this.db
        .update(motardDriveUploads)
        .set({
          stableKey,
          documentId: input.documentId,
          tenantId: input.tenantId,
          entityId: input.entityId,
          fileName: input.fileName,
          mimeType: input.mimeType,
          contentSha256: sha,
          contentBytes: content.length,
          revision: legacy.revision + 1,
          status: "pending",
          nextAttemptAt: null,
          lastError: null,
          updatedAt: nowIso(),
        })
        .where(eq(motardDriveUploads.id, legacy.id));
      return { id: legacy.id, deduped: false };
    }

    // 3. A new row.
    const id = randomUUID();
    await this.db.insert(motardDriveUploads).values({
      id,
      stableKey,
      entityType: input.entityType,
      entityId: input.entityId,
      documentId: input.documentId,
      tenantId: input.tenantId,
      periodKey,
      section: input.section,
      fileName: input.fileName,
      mimeType: input.mimeType,
      contentSha256: sha,
      contentBytes: content.length,
      status: "pending",
      deviceId: input.deviceId,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    return { id, deduped: false };
  }

  /**
   * The queue row of a document that was queued BEFORE migration 0008, if there is one.
   *
   * Such a row is found by its LEGACY identity: the same entity type, period and section, and a file
   * name that starts with the document's legacy name prefix (`${date}_${number}_`). The prefix is
   * how the row is matched even when the party was renamed since — the date and number identify the
   * invoice, and (tenant, type, number) is unique.
   *
   * The row that HOLDS the Drive file wins: a document that was re-archived after an edit has
   * several rows (one per revision) and only the last one carries the file id.
   */
  private async findAdoptableRow(
    input: EnqueueInput,
    periodKey: string,
  ): Promise<{ id: string; contentSha256: string; revision: number } | null> {
    if (!input.legacyNamePrefix) return null;
    const rows = await this.db
      .select({
        id: motardDriveUploads.id,
        contentSha256: motardDriveUploads.contentSha256,
        revision: motardDriveUploads.revision,
        driveFileId: motardDriveUploads.driveFileId,
        createdAt: motardDriveUploads.createdAt,
      })
      .from(motardDriveUploads)
      .where(
        and(
          eq(motardDriveUploads.entityType, input.entityType),
          eq(motardDriveUploads.periodKey, periodKey),
          eq(motardDriveUploads.section, input.section),
          // Only this tenant's rows — or a pre-0008 row whose tenant was never recorded.
          or(
            eq(motardDriveUploads.tenantId, input.tenantId),
            isNull(motardDriveUploads.tenantId),
            eq(motardDriveUploads.tenantId, "archive"),
          ),
          // GLOB, not LIKE: `_` is a literal in GLOB but a single-character wildcard in LIKE. The
          // prefix's own `*`, `?` and `[` are bracketed so they match only themselves (an invoice
          // number containing `?` matched a different invoice's row).
          sql`${motardDriveUploads.entityId} GLOB ${globLiteral(input.legacyNamePrefix)} || '*'`,
        ),
      )
      .orderBy(desc(motardDriveUploads.createdAt))
      .limit(5);
    if (!rows.length) return null;
    // Prefer the row that already points at a Drive file; that is the document's file.
    const withFile = rows.find((r) => r.driveFileId);
    return withFile ?? rows[0];
  }

  /**
   * Phase 4: enqueue a file that stays on disk. Same identity and dedupe rules as `enqueue`
   * (the stable key uses the streamed SHA-256), without holding the bytes in memory.
   *
   * A database backup is a NEW timestamped archive every time, so its document id is the file name
   * and it is never adopted from an older row.
   */
  async enqueueFile(input: EnqueueFileInput): Promise<{ id: string; deduped: boolean }> {
    const { sha256, size } = await hashFileStreaming(input.filePath);
    const periodKey = input.businessDate.slice(0, 7);
    const stableKey = stableKeyOfParts(
      input.entityType,
      input.documentId,
      periodKey,
      input.section,
      sha256,
    );
    const [existing] = await this.db
      .select()
      .from(motardDriveUploads)
      .where(eq(motardDriveUploads.stableKey, stableKey))
      .limit(1);
    if (existing) {
      if (existing.status === "done") return { id: existing.id, deduped: true };
      await this.db
        .update(motardDriveUploads)
        .set({ status: "pending", nextAttemptAt: null, lastError: null, updatedAt: nowIso() })
        .where(eq(motardDriveUploads.id, existing.id));
      return { id: existing.id, deduped: true };
    }
    const id = randomUUID();
    await this.db.insert(motardDriveUploads).values({
      id,
      stableKey,
      entityType: input.entityType,
      entityId: input.entityId,
      documentId: input.documentId,
      tenantId: input.tenantId,
      periodKey,
      section: input.section,
      fileName: input.fileName,
      mimeType: input.mimeType,
      contentSha256: sha256,
      contentBytes: size,
      status: "pending",
      deviceId: input.deviceId,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
    return { id, deduped: false };
  }

  /**
   * Claim one due row (lease). Expired `uploading` leases are reclaimed so a
   * crashed worker's work is never lost. `null` when nothing is due.
   */
  async claim(deviceId: string): Promise<ClaimedJob | null> {
    const now = nowIso();
    const due = or(
      eq(motardDriveUploads.status, "pending"),
      and(eq(motardDriveUploads.status, "uploading"), lte(motardDriveUploads.leaseUntil, now)),
      and(eq(motardDriveUploads.status, "failed"), lte(motardDriveUploads.nextAttemptAt, now)),
    );
    const candidates = await this.db
      .select()
      .from(motardDriveUploads)
      .where(due)
      .orderBy(asc(motardDriveUploads.createdAt))
      .limit(1);
    const row = candidates[0];
    if (!row) return null;
    const leaseToken = randomUUID();
    const until = toIso(new Date(Date.now() + LEASE_MS));
    // CAS (D-08): the UPDATE re-checks the row is still due, so a concurrent claimer that already
    // leased it (status → uploading, lease in the future) or finished it (done) makes this a no-op.
    const updated = await this.db
      .update(motardDriveUploads)
      .set({
        status: "uploading",
        leaseOwner: deviceId,
        leaseToken,
        leaseUntil: until,
        updatedAt: now,
      })
      .where(and(eq(motardDriveUploads.id, row.id), due))
      .returning();
    const claimed = updated[0];
    if (!claimed) return null;
    return {
      id: claimed.id,
      leaseToken,
      section: claimed.section,
      periodKey: claimed.periodKey,
      fileName: claimed.fileName,
      mimeType: claimed.mimeType,
      entityType: claimed.entityType,
      entityId: claimed.entityId,
      documentId: claimed.documentId,
      tenantId: claimed.tenantId ?? "archive",
      contentSha256: claimed.contentSha256,
      retryCount: claimed.retryCount,
    };
  }

  /**
   * Process one claimed job: ensure folders, upload, verify, mark done.
   * Returns the Drive file id on success.
   */
  async process(job: ClaimedJob, businessDate: string, content: Uint8Array): Promise<string> {
    // The queue carries only metadata + hash; the worker regenerates the bytes from the source records
    // (D-03) and hands them in per call — never a shared mutable hook a concurrent pass could swap.
    try {
      // H-12: a previous attempt that Drive already accepted left its file id on the row; verify THAT
      // file instead of creating a second one (a failed verification used to re-upload on retry).
      const [prior] = await this.db
        .select({
          driveFileId: motardDriveUploads.driveFileId,
          uploadedContentSha256: motardDriveUploads.uploadedContentSha256,
        })
        .from(motardDriveUploads)
        .where(this.owned(job))
        .limit(1);
      // The shortcut is only valid when the Drive file already holds EXACTLY this content. Without
      // the uploaded-hash check a revision (an edited invoice) would be marked done without ever
      // re-uploading, and the archive would keep the old content (migration 0008).
      let verified =
        prior?.driveFileId && prior.uploadedContentSha256 === job.contentSha256
          ? await this.drive.getFile(prior.driveFileId)
          : null;
      if (!verified) {
        const chain = await this.folders.ensureChain(businessDate, categoryOfSection(job.section));
        // Phase 2 upsert: a document already in Drive (same motardKey) is updated in place. The key
        // is derived from the document's IMMUTABLE id, so an edited, renamed or cancelled document
        // replaces its own file instead of adding a duplicate.
        const key = documentKey(job);
        const existing = await this.findExistingFile(job, key, prior?.driveFileId);
        const meta = existing
          ? await this.drive.updateMedia(existing.id, job.mimeType, content, job.fileName)
          : content.length > SMALL_UPLOAD_MAX
            ? await this.drive.uploadResumable(
                chain.sectionId,
                job.fileName,
                job.mimeType,
                content,
                key,
              )
            : await this.drive.uploadSmall(
                chain.sectionId,
                job.fileName,
                job.mimeType,
                content,
                key,
              );
        // Persist the accepted id AND the hash of what Drive now holds, before verifying. A failure
        // from here on retries BY ID: the retry finds the file that already exists and verifies it
        // instead of uploading a second one (H-12). The uploaded hash is what tells the retry whether
        // the file already holds THIS content — a revision must re-upload, a plain retry must not.
        await this.db
          .update(motardDriveUploads)
          .set({
            driveFileId: meta.id,
            uploadedContentSha256: job.contentSha256,
            updatedAt: nowIso(),
          })
          .where(this.owned(job));
        verified = await this.drive.getFile(meta.id);
        if (!verified) throw new Error("post-upload verification failed: file id not found");
      }
      // The content itself is verified, not just the file's existence: Drive returns the MD5 of
      // what it stored, and it must match the bytes we sent. A truncated or corrupted upload used
      // to be recorded as `done` — and the database backup is the only way back from a catastrophic
      // local loss, so a silent corruption here is a data-loss risk.
      if (verified.md5Checksum) {
        const md5 = createHash("md5").update(content).digest("hex");
        if (verified.md5Checksum !== md5) {
          throw new Error("post-upload verification failed: the stored content does not match");
        }
      }
      await this.markDone(job, verified);
      return verified.id;
    } catch (err) {
      await this.fail(job, err);
      throw err;
    }
  }

  /**
   * The Drive file that already holds this document, if any.
   *
   * The key is unique by construction, so the lookup is GLOBAL: a parent-scoped lookup missed the
   * file whenever the month or category folder had been recreated, which produced a duplicate.
   *
   * A file uploaded by 3.0.6 carries NO key at all (that version set no `appProperties`), so it
   * cannot be found by any key. What 3.0.6 did keep is the file's id, on the queue row — and an
   * upgraded row is adopted in place, so `priorFileId` still names that file. It is adopted by id
   * and given the new key, so from then on it is found by the key: one Drive file per document.
   */
  private async findExistingFile(
    job: ClaimedJob,
    key: string,
    priorFileId: string | null | undefined,
  ): Promise<{ id: string; name: string; mimeType: string } | null> {
    const found = await this.drive.findByAppKey(key);
    if (found) return found;
    if (job.entityType === "db_backup" || !priorFileId) return null; // a backup is always new
    const prior = await this.drive.getFile(priorFileId);
    if (!prior || prior.trashed) return null; // deleted or trashed on Drive: upload a fresh file
    await this.drive.updateAppProperties(prior.id, key);
    return prior;
  }

  /**
   * Phase 4: process a claimed job whose bytes are a file on disk. Same upsert, verification and failure
   * rules as `process`; only the transport streams from disk. Used for the database backup ZIP.
   */
  async processFile(
    job: ClaimedJob,
    businessDate: string,
    filePath: string,
    size: number,
  ): Promise<string> {
    try {
      const [prior] = await this.db
        .select({
          driveFileId: motardDriveUploads.driveFileId,
          uploadedContentSha256: motardDriveUploads.uploadedContentSha256,
        })
        .from(motardDriveUploads)
        .where(this.owned(job))
        .limit(1);
      let verified =
        prior?.driveFileId && prior.uploadedContentSha256 === job.contentSha256
          ? await this.drive.getFile(prior.driveFileId)
          : null;
      if (!verified) {
        const chain = await this.folders.ensureChain(businessDate, categoryOfSection(job.section));
        // A database backup is a NEW timestamped archive per backup, so it is always a new Drive file.
        // (Documents are upserted in `process`; a streamed in-place replacement is not implemented.)
        const key = documentKey(job);
        const meta = await this.drive.uploadResumableFromFile(
          chain.sectionId,
          job.fileName,
          job.mimeType,
          filePath,
          size,
          key,
        );
        await this.db
          .update(motardDriveUploads)
          .set({
            driveFileId: meta.id,
            uploadedContentSha256: job.contentSha256,
            updatedAt: nowIso(),
          })
          .where(this.owned(job));
        verified = await this.drive.getFile(meta.id);
        if (!verified) throw new Error("post-upload verification failed: file id not found");
      }
      // Same content check as `process`. This is the DATABASE BACKUP path — the copy a lost
      // installation is recovered from — so a truncated upload must never be recorded as `done`.
      if (verified.md5Checksum && verified.md5Checksum !== (await md5OfFile(filePath))) {
        throw new Error("post-upload verification failed: the stored content does not match");
      }
      await this.markDone(job, verified);
      return verified.id;
    } catch (err) {
      await this.fail(job, err);
      throw err;
    }
  }

  /** Drop a claimed job whose source no longer exists or changed (a newer row carries it, D-10). */
  async drop(job: ClaimedJob): Promise<void> {
    await this.db
      .delete(motardDriveUploads)
      .where(
        and(eq(motardDriveUploads.id, job.id), eq(motardDriveUploads.leaseToken, job.leaseToken)),
      );
  }

  /** The row as long as this job still holds its lease (H-13: a stale worker's writes are no-ops). */
  private owned(job: ClaimedJob) {
    return and(
      eq(motardDriveUploads.id, job.id),
      eq(motardDriveUploads.leaseToken, job.leaseToken),
    );
  }

  private async markDone(job: ClaimedJob, verified: DriveFileMeta): Promise<void> {
    await this.db
      .update(motardDriveUploads)
      .set({
        status: "done",
        driveFileId: verified.id,
        // What Drive actually holds. A later revision is detected by comparing this with the row's
        // `contentSha256` — without it the retry shortcut would skip the re-upload (migration 0008).
        uploadedContentSha256: job.contentSha256,
        uploadedAt: nowIso(),
        leaseToken: null,
        leaseUntil: null,
        lastError: null,
        updatedAt: nowIso(),
      })
      .where(this.owned(job));
  }

  private async fail(job: ClaimedJob, err: unknown): Promise<void> {
    // H-13: only while this job still holds the lease — an expired worker failing late used to
    // overwrite the newer worker's `done` with `failed`.
    const [row] = await this.db.select().from(motardDriveUploads).where(this.owned(job)).limit(1);
    if (!row) return;
    const retryCount = row.retryCount + 1;
    // Authorization failure: blocked, not retried — needs the user to reconnect.
    if (err instanceof DriveAuthError) {
      await this.db
        .update(motardDriveUploads)
        .set({
          status: "blocked",
          lastError: "AUTH",
          leaseToken: null,
          leaseUntil: null,
          updatedAt: nowIso(),
        })
        .where(this.owned(job));
      return;
    }
    // D-09: a permanent or exhausted failure needs the operator (retry action) → blocked; a
    // retryable one stays failed with its next attempt, which claim() picks up by itself.
    const stop = (err instanceof DriveError && !err.retryable) || retryCount >= MAX_RETRIES;
    await this.db
      .update(motardDriveUploads)
      .set({
        status: stop ? "blocked" : "failed",
        retryCount,
        nextAttemptAt: stop
          ? null
          : toIso(new Date(Date.now() + Math.min(60000 * 2 ** retryCount, 6 * 3600000))),
        lastError: String(err).slice(0, 500),
        leaseToken: null,
        leaseUntil: null,
        updatedAt: nowIso(),
      })
      .where(this.owned(job));
  }

  /** Requeue a failed/blocked job on user request (retry action). */
  async retry(jobId: string): Promise<void> {
    await this.db
      .update(motardDriveUploads)
      .set({
        status: "pending",
        nextAttemptAt: null,
        retryCount: 0,
        lastError: null,
        updatedAt: nowIso(),
      })
      .where(
        and(
          eq(motardDriveUploads.id, jobId),
          or(eq(motardDriveUploads.status, "failed"), eq(motardDriveUploads.status, "blocked")),
        ),
      );
  }

  /** Queue snapshot for the settings screen. */
  async stats(): Promise<{
    pending: number;
    uploading: number;
    done: number;
    failed: number;
    blocked: number;
  }> {
    const rows = await this.db
      .select({ status: motardDriveUploads.status, n: sql<number>`count(*)` })
      .from(motardDriveUploads)
      .groupBy(motardDriveUploads.status);
    const out = { pending: 0, uploading: 0, done: 0, failed: 0, blocked: 0 };
    for (const r of rows) out[r.status as keyof typeof out] = Number(r.n);
    return out;
  }
}

export type ClaimedJob = {
  id: string;
  leaseToken: string;
  section: string;
  periodKey: string;
  fileName: string;
  mimeType: string;
  entityType: string;
  entityId: string;
  /** The immutable business document id (null on rows written before migration 0008). */
  documentId: string | null;
  /** The real tenant ("archive" on rows written before migration 0008). */
  tenantId: string;
  contentSha256: string;
  retryCount: number;
};
