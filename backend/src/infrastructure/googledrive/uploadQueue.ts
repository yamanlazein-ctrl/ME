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
import { and, asc, eq, lte, or, sql } from "drizzle-orm";
import { motardDriveUploads } from "../orm/sqlite/schemas/drive-archive.table.js";
import type { DriveClient, DriveFileMeta } from "./driveClient.js";
import { DriveAuthError, DriveError } from "./driveClient.js";
import type { FolderOrganizer } from "./folderOrganizer.js";
import type { DB } from "../orm/sqlite/drizzleCompat.js";

export type EnqueueInput = {
  entityType: string;
  entityId: string;
  businessDate: string; // YYYY-MM-DD
  section: string;
  fileName: string;
  mimeType: string;
  content: Uint8Array | string;
  deviceId: string;
};

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

function contentOf(c: Uint8Array | string): Uint8Array {
  return typeof c === "string" ? new TextEncoder().encode(c) : c;
}

export function stableKeyOfParts(entityType: string, entityId: string, periodKey: string, section: string, contentSha256: string): string {
  return [entityType, entityId, periodKey, section, contentSha256].join("|");
}

export class UploadQueue {
  constructor(
    private readonly db: DB,
    private readonly drive: DriveClient,
    private readonly folders: FolderOrganizer,
  ) {}

  /**
   * Enqueue one archive unit. Idempotent: the same (entity, period, section,
   * content-hash) collapses into the existing row; changed content bumps the
   * revision and enqueues fresh work. Never throws on Drive problems — the
   * queue is local state.
   */
  async enqueue(input: EnqueueInput): Promise<{ id: string; deduped: boolean }> {
    const content = contentOf(input.content);
    const sha = createHash("sha256").update(content).digest("hex");
    const periodKey = input.businessDate.slice(0, 7);
    const stableKey = stableKeyOfParts(input.entityType, input.entityId, periodKey, input.section, sha);

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

    const id = randomUUID();
    await this.db.insert(motardDriveUploads).values({
      id,
      stableKey,
      entityType: input.entityType,
      entityId: input.entityId,
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
      .set({ status: "uploading", leaseOwner: deviceId, leaseToken, leaseUntil: until, updatedAt: now })
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
      const chain = await this.folders.ensureChain(businessDate, job.section as never);
      const meta =
        content.length > SMALL_UPLOAD_MAX
          ? await this.drive.uploadResumable(chain.sectionId, job.fileName, job.mimeType, content)
          : await this.drive.uploadSmall(chain.sectionId, job.fileName, job.mimeType, content);
      const verified = await this.drive.getFile(meta.id);
      if (!verified) throw new Error("post-upload verification failed: file id not found");
      await this.markDone(job, meta, verified);
      return meta.id;
    } catch (err) {
      await this.fail(job, err);
      throw err;
    }
  }

  /** Drop a claimed job whose source no longer exists or changed (a newer row carries it, D-10). */
  async drop(job: ClaimedJob): Promise<void> {
    await this.db
      .delete(motardDriveUploads)
      .where(and(eq(motardDriveUploads.id, job.id), eq(motardDriveUploads.leaseToken, job.leaseToken)));
  }

  private async markDone(job: ClaimedJob, meta: DriveFileMeta, verified: DriveFileMeta): Promise<void> {
    await this.db
      .update(motardDriveUploads)
      .set({
        status: "done",
        driveFileId: verified.id,
        uploadedAt: nowIso(),
        leaseToken: null,
        leaseUntil: null,
        lastError: null,
        updatedAt: nowIso(),
      })
      .where(and(eq(motardDriveUploads.id, job.id), eq(motardDriveUploads.leaseToken, job.leaseToken)));
    void meta;
  }

  private async fail(job: ClaimedJob, err: unknown): Promise<void> {
    const [row] = await this.db.select().from(motardDriveUploads).where(eq(motardDriveUploads.id, job.id)).limit(1);
    if (!row) return;
    const retryCount = row.retryCount + 1;
    // Authorization failure: blocked, not retried — needs the user to reconnect.
    if (err instanceof DriveAuthError) {
      await this.db
        .update(motardDriveUploads)
        .set({ status: "blocked", lastError: "AUTH", leaseToken: null, leaseUntil: null, updatedAt: nowIso() })
        .where(eq(motardDriveUploads.id, job.id));
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
        nextAttemptAt: stop ? null : toIso(new Date(Date.now() + Math.min(60000 * 2 ** retryCount, 6 * 3600000))),
        lastError: String(err).slice(0, 500),
        leaseToken: null,
        leaseUntil: null,
        updatedAt: nowIso(),
      })
      .where(eq(motardDriveUploads.id, job.id));
  }

  /** Requeue a failed/blocked job on user request (retry action). */
  async retry(jobId: string): Promise<void> {
    await this.db
      .update(motardDriveUploads)
      .set({ status: "pending", nextAttemptAt: null, retryCount: 0, lastError: null, updatedAt: nowIso() })
      .where(and(eq(motardDriveUploads.id, jobId), or(eq(motardDriveUploads.status, "failed"), eq(motardDriveUploads.status, "blocked"))));
  }

  /** Queue snapshot for the settings screen. */
  async stats(): Promise<{ pending: number; uploading: number; done: number; failed: number; blocked: number }> {
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
  contentSha256: string;
  retryCount: number;
};
