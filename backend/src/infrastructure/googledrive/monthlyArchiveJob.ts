/**
 * Monthly archive job — the worker + catch-up scheduler for the Drive archive.
 *
 * Lifecycle (mirrors sqliteBackupScheduler conventions):
 *   - `startDriveArchiveWorker` on boot (desktop SQLite only), `stop…` for
 *     shutdown. Timer is unref'd so it never keeps the process alive.
 *   - Every tick: catch-up documents pass (uncovered months by business
 *     date), then process the upload queue. All Drive work is local/queued —
 *     normal ERP transactions never touch this module.
 *   - Fail-closed: every pass runs `authorizeUploadDevice` first; a secondary
 *     or unassigned device skips uploading but keeps enqueueing nothing.
 *
 * Backup eligibility: only `verifiedBackups()` entries (VERIFIED + file
 * exists) from the EXISTING registry are enqueued; a live database file is
 * never copied here.
 *
 * Content idempotency: enqueue keys on a content hash, so unchanged documents
 * are never re-exported or re-uploaded, and revised documents enqueue fresh
 * work with a new hash (the queue dedupes the rest).
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { eq } from "drizzle-orm";
import { motardDriveRuns } from "../orm/sqlite/schemas/drive-archive.table.js";
import { authorizeUploadDevice } from "./coordinator.js";
import { Exporters } from "./exporters.js";
import { FolderOrganizer } from "./folderOrganizer.js";
import { DriveClient } from "./driveClient.js";
import { UploadQueue, type ClaimedJob } from "./uploadQueue.js";
import type { SectionKey } from "./archiveCore.js";
import { verifiedBackups } from "../backup/backupRegistry.js";
import type { DB } from "../orm/sqlite/drizzleCompat.js";
import { logger } from "../config/logger.js";

const MONTH_MS = 31 * 24 * 60 * 60 * 1000;
const CATCHUP_MONTHS = 24; // don't walk history forever on a fresh install
const TICK_MS = 6 * 60 * 60 * 1000; // 4×/day; catch-up makes the rest safe

export type DriveWorkerDeps = {
  db: DB;
  queue: UploadQueue;
  folders: FolderOrganizer;
  exporters: Exporters;
  /** Live Drive client (token-refreshing); null when not connected. */
  drive: DriveClient | null;
  localDeviceId: string | null;
};

let timer: ReturnType<typeof setInterval> | null = null;

function nowIso(): string {
  return new Date().toISOString();
}

function periodKeyOf(date: Date): string {
  return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}`;
}

/** All month starts from `monthsBack` ago through the current month. */
function recentMonthStarts(monthsBack: number): Date[] {
  const out: Date[] = [];
  const now = new Date();
  for (let i = monthsBack - 1; i >= 0; i--) {
    out.push(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1)));
  }
  return out;
}

type SourceFile = { section: SectionKey; entityType: string; fileName: string; mimeType: string; content: Uint8Array };

/** Every archive file the source records produce for one month (deterministic names = identity). */
async function monthFiles(exporters: Exporters, periodKey: string): Promise<SourceFile[]> {
  const out: SourceFile[] = [];
  for (const r of await exporters.invoicesForPeriod(periodKey, "sale")) out.push({ section: "salesInvoices", entityType: "invoice", ...r });
  for (const r of await exporters.invoicesForPeriod(periodKey, "entry")) out.push({ section: "purchaseInvoices", entityType: "invoice", ...r });
  for (const r of await exporters.expensesForPeriod(periodKey)) out.push({ section: "cashboxExpenses", entityType: "expenses", ...r });
  return out;
}

/**
 * Rebuild one claimed job's bytes from its source (D-03/D-10): documents from the exporters, a
 * database backup from its VERIFIED file. `null` when the source is gone or its content changed —
 * a newer queue row (new content hash) then carries the current version.
 */
async function regenerate(exporters: Exporters, job: ClaimedJob): Promise<Uint8Array | null> {
  let content: Uint8Array | null = null;
  if (job.entityType === "db_backup") {
    content = existsSync(job.entityId) ? readFileSync(job.entityId) : null;
  } else {
    const match = (await monthFiles(exporters, job.periodKey)).find((f) => f.section === job.section && f.fileName === job.fileName);
    content = match?.content ?? null;
  }
  if (!content) return null;
  return createHash("sha256").update(content).digest("hex") === job.contentSha256 ? content : null;
}

let passInFlight = false;

/**
 * One archive pass: authorize, enqueue the month exports of uncovered months plus the newest VERIFIED
 * backup, then upload queued work. Fail-closed: a device that may not upload enqueues nothing either
 * (no point exporting 24 months every tick on a secondary device). One pass at a time per process —
 * the timer and "sync now" share this guard, so a lease is never raced by our own second pass.
 */
export async function runArchivePass(deps: DriveWorkerDeps, trigger: "startup" | "timer" | "manual" | "connect"): Promise<{ enqueued: number; processed: number; uploaded: number; skipped: string | null }> {
  const { db, queue, exporters } = deps;
  const drive = deps.drive; // read once: the live client can disappear (disconnect) mid-pass
  const report = { enqueued: 0, processed: 0, uploaded: 0, skipped: null as string | null };
  if (passInFlight) return { ...report, skipped: "BUSY" };
  if (!deps.localDeviceId) return { ...report, skipped: "NO_DEVICE_IDENTITY" };
  const decision = await authorizeUploadDevice(db, deps.localDeviceId);
  if (!decision.allowed) return { ...report, skipped: decision.reason };
  if (!drive) return { ...report, skipped: "NOT_CONNECTED" };
  const deviceId = deps.localDeviceId;

  passInFlight = true;
  const [run] = await db
    .insert(motardDriveRuns)
    .values({ id: crypto.randomUUID(), kind: "catchup", state: "running", startedAt: nowIso() })
    .returning();
  try {
    const months = recentMonthStarts(CATCHUP_MONTHS);
    for (const start of months) {
      const periodKey = periodKeyOf(start);
      try {
        for (const f of await monthFiles(exporters, periodKey)) {
          const r = await queue.enqueue({
            entityType: f.entityType,
            entityId: f.fileName, // deterministic filename is the stable identity
            businessDate: f.fileName.slice(0, 10),
            section: f.section,
            fileName: f.fileName,
            mimeType: f.mimeType,
            content: f.content,
            deviceId,
          });
          if (!r.deduped) report.enqueued++;
        }
      } catch (err) {
        logger.error({ err, periodKey }, "DRIVE_CATCHUP_PERIOD_FAILED");
      }
    }
    if ((await enqueueVerifiedBackupUpload(deps)).enqueued) report.enqueued++;

    for (let i = 0; i < 25; i++) {
      const job = await queue.claim(deviceId);
      if (!job) break;
      const content = await regenerate(exporters, job);
      if (!content) {
        await queue.drop(job);
        continue;
      }
      report.processed++;
      try {
        if (await queue.process(job, job.periodKey + "-01", content)) report.uploaded++;
      } catch (err) {
        // process() already recorded retry/backoff/blocked; back off until the next pass.
        logger.warn({ err, jobId: job.id }, "DRIVE_UPLOAD_RETRY_SCHEDULED");
        break;
      }
    }

    await db
      .update(motardDriveRuns)
      .set({ state: "done", finishedAt: nowIso(), detail: JSON.stringify({ trigger, ...report }) })
      .where(eq(motardDriveRuns.id, run.id));
  } catch (err) {
    await db
      .update(motardDriveRuns)
      .set({ state: "failed", finishedAt: nowIso(), detail: String(err).slice(0, 300) })
      .where(eq(motardDriveRuns.id, run.id));
    throw err;
  } finally {
    passInFlight = false;
  }
  return report;
}

/** Enqueue the newest VERIFIED automatic backup (idempotent by content hash). */
export async function enqueueVerifiedBackupUpload(deps: DriveWorkerDeps): Promise<{ enqueued: boolean; fileName: string | null }> {
  const newest = verifiedBackups("automatic")[0];
  if (!newest) return { enqueued: false, fileName: null };
  const r = await deps.queue.enqueue({
    entityType: "db_backup",
    entityId: newest.path,
    businessDate: newest.createdAt.slice(0, 10),
    section: "dbBackups",
    fileName: newest.path.split(/[\\/]/).pop() ?? "backup.zip",
    mimeType: "application/zip",
    content: readFileSync(newest.path),
    deviceId: deps.localDeviceId ?? "unknown",
  });
  return { enqueued: !r.deduped, fileName: newest.path };
}

export function startDriveArchiveWorker(deps: DriveWorkerDeps): void {
  if (timer) return;
  void runArchivePass(deps, "startup").catch((err) => logger.error({ err }, "DRIVE_ARCHIVE_STARTUP_PASS_FAILED"));
  timer = setInterval(() => {
    void runArchivePass(deps, "timer").catch((err) => logger.error({ err }, "DRIVE_ARCHIVE_TICK_FAILED"));
  }, TICK_MS);
  timer.unref?.();
}

export function stopDriveArchiveWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
