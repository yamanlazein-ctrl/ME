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
import { existsSync } from "node:fs";
import { readFile, rm } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { and, eq, ne, sql } from "drizzle-orm";
import { motardDriveRuns, motardDriveUploads } from "../orm/sqlite/schemas/drive-archive.table.js";
import { invoices } from "../orm/sqlite/schemas/invoice.table.js";
import { expenses } from "../orm/sqlite/schemas/expense.table.js";
import {
  advance,
  encodeDetail,
  finalState,
  finishLiveRun,
  getLiveRun,
  newRunProgress,
  recordError,
  setTotal,
  startLiveRun,
  updateLiveRun,
  type RunProgress,
  type RunState,
  type RunTrigger,
} from "./archiveRuns.js";
import { authorizeUploadDevice } from "./coordinator.js";
import { Exporters } from "./exporters.js";
import { FolderOrganizer } from "./folderOrganizer.js";
import { DriveClient } from "./driveClient.js";
import { UploadQueue, type ClaimedJob } from "./uploadQueue.js";
import { planArchivePeriods, type ArchiveTrigger } from "./archiveSchedule.js";
import { renderPeriodDocuments } from "./archiveDocuments.js";
import type { SectionKey } from "./archiveCore.js";
import { verifiedBackups } from "../backup/backupRegistry.js";
import type { DB } from "../orm/sqlite/drizzleCompat.js";
import { logger } from "../config/logger.js";

const CATCHUP_MONTHS = 24; // don't walk history forever on a fresh install
const TICK_MS = 6 * 60 * 60 * 1000; // 4×/day; catch-up makes the rest safe
/**
 * Uploads per pass. A pass holds the run guard, so it is bounded; but at 25 per 6-hour tick a
 * two-year backlog (thousands of documents) took months to drain.
 */
const MAX_JOBS_PER_PASS = 200;

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

type SourceFile = {
  section: SectionKey;
  entityType: string;
  fileName: string;
  mimeType: string;
  content: Uint8Array;
  /** The business document's immutable id — the Drive upsert key is derived from it. */
  documentId: string;
  /** The pre-upgrade file-name prefix, used once to adopt a row written before migration 0008. */
  legacyNamePrefix?: string | null;
};

/** Every archive file the source records produce for one month. */
async function monthFiles(exporters: Exporters, periodKey: string): Promise<SourceFile[]> {
  const out: SourceFile[] = [];
  for (const r of await exporters.invoicesForPeriod(periodKey, "sale"))
    out.push({ section: "sale_invoices", entityType: "invoice", ...r });
  for (const r of await exporters.invoicesForPeriod(periodKey, "entry"))
    out.push({ section: "entry_invoices", entityType: "invoice", ...r });
  for (const r of await exporters.expensesForPeriod(periodKey))
    out.push({ section: "cashbox", entityType: "expenses", ...r });
  return out;
}

/**
 * Rebuild one claimed job's bytes from its source (D-03/D-10): documents from the exporters, a
 * database backup from its VERIFIED file. `null` when the source is gone or its content changed —
 * a newer queue row (new content hash) then carries the current version.
 */
/**
 * Phase 4: the database backup of a job, as a file on disk. Accepted only if the file still exists and
 * its streamed SHA-256 equals the job's recorded hash (a rewritten file is not uploaded as the old backup).
 */
async function streamBackupForJob(job: ClaimedJob): Promise<{ path: string; size: number } | null> {
  if (!existsSync(job.entityId)) return null;
  const { hashFileStreaming } = await import("./uploadQueue.js");
  const { sha256, size } = await hashFileStreaming(job.entityId);
  return sha256 === job.contentSha256 ? { path: job.entityId, size } : null;
}

/**
 * Rebuild one claimed job's bytes from its source (D-03/D-10): documents from the exporters, a
 * database backup from its VERIFIED file. `null` when the source is gone or its content changed —
 * a newer queue row (new content hash) then carries the current version.
 *
 * The month's export is CACHED for the pass: regenerating it per claimed job was O(jobs × months)
 * — the whole month was re-exported for every single file.
 */
async function regenerate(
  exporters: Exporters,
  job: ClaimedJob,
  cache: Map<string, SourceFile[]>,
): Promise<Uint8Array | null> {
  let content: Uint8Array | null = null;
  if (job.entityType === "db_backup") {
    // Backups are handled by streamBackupForJob in the pass loop; never load them here.
    return null;
  } else {
    let files = cache.get(job.periodKey);
    if (!files) {
      files = await monthFiles(exporters, job.periodKey);
      cache.set(job.periodKey, files);
    }
    const match = files.find((f) => f.section === job.section && f.fileName === job.fileName);
    content = match?.content ?? null;
  }
  if (!content) return null;
  return createHash("sha256").update(content).digest("hex") === job.contentSha256 ? content : null;
}

let passInFlight = false;

/** The newest change (`updated_at`) to the archived records of each period. */
async function lastChangeByPeriod(db: DB): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const t of [invoices, expenses]) {
    const period = sql<string>`substr(${t.date}, 1, 7)`;
    const rows = await db
      .select({ period, last: sql<string>`max(${t.updatedAt})` })
      .from(t)
      .groupBy(period);
    for (const r of rows) {
      const at = Date.parse(r.last);
      if (Number.isFinite(at) && at > (out.get(r.period) ?? 0)) out.set(r.period, at);
    }
  }
  return out;
}

/**
 * The periods that are archived and still current.
 *
 * A period is covered by a `done` documents-run only when that run
 *   - STARTED AFTER THE PERIOD ENDED: a manual run of the still-open month must not cover it, or
 *     every document dated after that run would never be archived once the month closed; and
 *   - FINISHED AFTER THE LAST CHANGE to the period's documents: an invoice edited or cancelled
 *     after its month was archived makes the month due again, so the archived copy is refreshed
 *     (the upload is keyed by the document id, so its Drive file is updated in place).
 */
async function coveredPeriods(db: DB): Promise<string[]> {
  const rows = await db
    .select({
      periodKey: motardDriveRuns.periodKey,
      state: motardDriveRuns.state,
      startedAt: motardDriveRuns.startedAt,
      finishedAt: motardDriveRuns.finishedAt,
    })
    .from(motardDriveRuns)
    .where(eq(motardDriveRuns.kind, "documents"));
  const newestDone = new Map<string, number>();
  for (const r of rows) {
    if (r.state !== "done" || !r.periodKey || !r.finishedAt) continue;
    if (r.startedAt.slice(0, 7) <= r.periodKey) continue; // taken while the month was open
    const at = Date.parse(r.finishedAt);
    if (at > (newestDone.get(r.periodKey) ?? 0)) newestDone.set(r.periodKey, at);
  }
  const changed = await lastChangeByPeriod(db);
  return [...newestDone]
    .filter(([period, finished]) => (changed.get(period) ?? 0) <= finished)
    .map(([period]) => period);
}

/** Queue rows of each period that are not uploaded yet (the documents; backups are not a period's). */
async function outstandingByPeriod(db: DB): Promise<Map<string, number>> {
  const rows = await db
    .select({ period: motardDriveUploads.periodKey, n: sql<number>`count(*)` })
    .from(motardDriveUploads)
    .where(
      and(ne(motardDriveUploads.status, "done"), ne(motardDriveUploads.entityType, "db_backup")),
    )
    .groupBy(motardDriveUploads.periodKey);
  return new Map(rows.map((r) => [r.period, Number(r.n)]));
}

/**
 * The bytes of a rendered document staged by the shell, if it is still the file the job recorded.
 * PDFs are small, so they are read whole and go through the same upsert as the CSV exports.
 */
async function stagedDocumentForJob(job: ClaimedJob): Promise<Uint8Array | null> {
  const bytes = await readFile(job.entityId).catch(() => null);
  if (!bytes) return null;
  return createHash("sha256").update(bytes).digest("hex") === job.contentSha256 ? bytes : null;
}

/**
 * Remove a staged render once it is uploaded (or superseded). Only a file inside an
 * `archive-staging` folder is ever removed: the path came from the shell, and this must never be
 * able to delete anything else.
 */
async function removeStaged(path: string): Promise<void> {
  if (!resolve(path).split(sep).includes("archive-staging")) return;
  await rm(path, { force: true }).catch(() => {});
}

export type ArchivePassReport = {
  enqueued: number;
  processed: number;
  uploaded: number;
  skipped: string | null;
  /** The periods this pass archived (oldest first). */
  periods: string[];
  /** The run id the progress is published on (the first period's run). */
  runId: string | null;
};

/**
 * One archive pass: authorize, archive every period that is still missing, upload the queued work.
 *
 * Fail-closed: a device that may not upload enqueues nothing either. One pass at a time per
 * process — the timer, the connect trigger and the manual button share this guard.
 *
 * The periods are chosen by the pure planner (archiveSchedule.planArchivePeriods): only the months
 * that have ENDED and are not archived yet, so a second tick does no work at all, the month-end
 * archive happens after the month closed, and a desktop that was off for three months archives all
 * three.
 */
export async function runArchivePass(
  deps: DriveWorkerDeps,
  trigger: "startup" | "timer" | "manual" | "connect" | "monthly" | "catchup",
  opts: { periodKey?: string; onRun?: (runId: string) => void } = {},
): Promise<ArchivePassReport> {
  const { db, queue, exporters } = deps;
  const drive = deps.drive; // read once: the live client can disappear (disconnect) mid-pass
  const report: ArchivePassReport = {
    enqueued: 0,
    processed: 0,
    uploaded: 0,
    skipped: null,
    periods: [],
    runId: null,
  };
  if (!deps.localDeviceId) return { ...report, skipped: "NO_DEVICE_IDENTITY" };
  const decision = await authorizeUploadDevice(db, deps.localDeviceId);
  if (!decision.allowed) return { ...report, skipped: decision.reason };
  if (!drive) return { ...report, skipped: "NOT_CONNECTED" };
  const deviceId = deps.localDeviceId;
  const tenantId = decision.tenantId;

  // The guard is checked and set with NO await in between, so the check-and-set is atomic: the
  // timer, the connect trigger and the manual button can all fire and exactly one of them runs.
  // The old code awaited the authorization BETWEEN the check and the set, which opened a window in
  // which a second pass could start.
  if (passInFlight) return { ...report, skipped: "BUSY" };
  passInFlight = true;
  const today = periodKeyOf(new Date());
  // The latest progress, kept outside the try so the catch block can read it. It is read through
  // `lastProgress()` because TypeScript does not track an assignment made inside a closure.
  let outerProgress: RunProgress | null = null;
  const lastProgress = (): RunProgress | null => outerProgress;
  try {
    const plan = opts.periodKey
      ? { periods: [opts.periodKey], trigger: "manual" as ArchiveTrigger }
      : planArchivePeriods({
          today,
          covered: await coveredPeriods(db),
          includeCurrent: trigger === "manual",
          maxLookback: CATCHUP_MONTHS,
        });
    // No period may need archiving — the queue is still drained below. Returning early here left
    // every pending row and every failed row awaiting its retry stuck until the next month ended,
    // and a newer verified backup was never queued in between.
    report.periods = plan.periods;

    // One run row per period: the durable record of "this period is archived". The coverage of the
    // next tick is read back from these rows.
    const periodRuns: Array<{ period: string; runId: string }> = [];
    const exportCache = new Map<string, SourceFile[]>();
    for (const period of plan.periods) {
      const [run] = await db
        .insert(motardDriveRuns)
        .values({
          id: crypto.randomUUID(),
          kind: "documents",
          state: "running",
          trigger: plan.trigger,
          periodKey: period,
          startedAt: nowIso(),
        })
        .returning();
      periodRuns.push({ period, runId: run.id });
    }
    // The active run is the NEWEST period's row: the periods are archived oldest first, and the
    // newest is the one the operator is watching. It is published as soon as it exists so the
    // caller can poll it. A pass that only drains the queue has no run.
    const activeRun = periodRuns.at(-1)?.runId ?? null;
    report.runId = activeRun;
    if (activeRun) opts.onRun?.(activeRun);

    for (const [index, period] of plan.periods.entries()) {
      const files = await monthFiles(exporters, period);
      exportCache.set(period, files);
      // The documents whose export is new or changed since they were last archived — the CSV's
      // content-hash dedupe is the change detector. Only these are rendered to PDF again.
      const changed = new Set<string>();
      for (const f of files) {
        const r = await queue.enqueue({
          entityType: f.entityType,
          entityId: f.fileName, // the locator: the deterministic file name
          // The identity: the business document's immutable id. The Drive upsert key is derived
          // from it, so an edited, renamed or cancelled document updates its own Drive file
          // instead of adding a second one.
          documentId: f.documentId,
          tenantId,
          legacyNamePrefix: f.legacyNamePrefix,
          businessDate: f.fileName.slice(0, 10),
          section: f.section,
          fileName: f.fileName,
          mimeType: f.mimeType,
          content: f.content,
          deviceId,
        });
        if (!r.deduped) {
          report.enqueued++;
          changed.add(f.documentId);
        }
      }
      // The DOCUMENTS: the same period's invoices, rendered to PDF by the shell. The CSV above is
      // the data export and stays the fallback for a period with no shell on the other end.
      const periodRunId = periodRuns[index].runId;
      for (const doc of await renderPeriodDocuments(db, periodRunId, period, changed)) {
        const r = await queue.enqueueFile({
          entityType: "invoice_pdf",
          entityId: doc.path, // the locator: the staged file on disk
          documentId: doc.documentId, // the identity: the invoice's immutable id
          tenantId,
          legacyNamePrefix: null,
          businessDate: period + "-01",
          section: doc.section,
          fileName: doc.fileName,
          mimeType: "application/pdf",
          filePath: doc.path,
          deviceId,
        });
        if (!r.deduped) report.enqueued++;
      }
    }
    // The newest VERIFIED backup is one artefact, not a month of documents; it joins this pass.
    if ((await enqueueVerifiedBackupUpload(deps, tenantId)).enqueued) report.enqueued++;

    let progress = newRunProgress(plan.trigger, plan.periods[0] ?? today);
    if (activeRun) startLiveRun(activeRun, progress);
    /** Publish the progress and remember it for the catch block. */
    const publish = (p: RunProgress): RunProgress => {
      outerProgress = p;
      return activeRun ? updateLiveRun(activeRun, p) : p;
    };
    // The total is the work this pass will try: the pending and due rows now. It can grow if a retry
    // or a new document arrives; progress never passes it (see archiveRuns.advance).
    const pending = await db
      .select({ id: motardDriveUploads.id })
      .from(motardDriveUploads)
      .where(eq(motardDriveUploads.status, "pending"));
    progress = setTotal(progress, Math.min(pending.length, MAX_JOBS_PER_PASS));
    progress = publish(progress);
    // The work list is known: record the total durably, so a run that dies mid-pass still says
    // how much it was trying to do.
    if (activeRun) {
      await db
        .update(motardDriveRuns)
        .set({ progressTotal: progress.total, progressDone: progress.done })
        .where(eq(motardDriveRuns.id, activeRun));
    }
    let attempted = 0;
    // How each period fared, so every period's run row records its own outcome.
    const byPeriod = new Map<string, { ok: number; failed: number }>();
    const tally = (period: string) => {
      const t = byPeriod.get(period) ?? { ok: 0, failed: 0 };
      byPeriod.set(period, t);
      return t;
    };

    for (let i = 0; i < MAX_JOBS_PER_PASS; i++) {
      // cancel stops after the current file
      if (activeRun && getLiveRun(activeRun)?.progress.cancelRequested) break;
      const job = await queue.claim(deviceId);
      if (!job) break;
      attempted++;
      const fileName = job.fileName;
      // A rendered document (the invoice PDF) was staged by the shell. It is uploaded through the
      // same upsert as the exports — keyed by the invoice id, so a re-render updates its Drive file —
      // and removed from the staging folder once it is up (or superseded).
      if (job.entityType === "invoice_pdf") {
        const bytes = await stagedDocumentForJob(job);
        if (!bytes) {
          await queue.drop(job);
          await removeStaged(job.entityId);
          progress = publish(advance(progress, fileName));
          continue;
        }
        report.processed++;
        try {
          if (await queue.process(job, job.periodKey + "-01", bytes)) report.uploaded++;
          await removeStaged(job.entityId);
          tally(job.periodKey).ok++;
          progress = advance(progress, fileName);
        } catch (err) {
          logger.warn({ err, jobId: job.id }, "DRIVE_UPLOAD_RETRY_SCHEDULED");
          tally(job.periodKey).failed++;
          progress = publish(recordError(progress, fileName, String(err).slice(0, 200)));
          break;
        }
        progress = publish(progress);
        continue;
      }
      // Phase 4: a database backup is streamed from disk. Its bytes are never loaded whole; the file
      // is accepted only if its streamed SHA-256 still matches the job, so a changed file is dropped.
      if (job.entityType === "db_backup") {
        const streamed = await streamBackupForJob(job);
        if (!streamed) {
          await queue.drop(job);
          progress = advance(progress, fileName);
          progress = publish(progress);
          continue;
        }
        report.processed++;
        try {
          if (await queue.processFile(job, job.periodKey + "-01", streamed.path, streamed.size)) {
            report.uploaded++;
          }
          tally(job.periodKey).ok++;
          progress = advance(progress, fileName);
        } catch (err) {
          logger.warn({ err, jobId: job.id }, "DRIVE_UPLOAD_RETRY_SCHEDULED");
          tally(job.periodKey).failed++;
          progress = recordError(progress, fileName, String(err).slice(0, 200));
          progress = publish(progress);
          break;
        }
        progress = publish(progress);
        continue;
      }
      const content = await regenerate(exporters, job, exportCache);
      if (!content) {
        await queue.drop(job);
        progress = advance(progress, fileName);
        progress = publish(progress);
        continue;
      }
      report.processed++;
      try {
        if (await queue.process(job, job.periodKey + "-01", content)) report.uploaded++;
        tally(job.periodKey).ok++;
        progress = advance(progress, fileName);
      } catch (err) {
        // process() already recorded retry/backoff/blocked; back off until the next pass.
        logger.warn({ err, jobId: job.id }, "DRIVE_UPLOAD_RETRY_SCHEDULED");
        tally(job.periodKey).failed++;
        progress = recordError(progress, fileName, String(err).slice(0, 200));
        progress = publish(progress);
        break;
      }
      progress = publish(progress);
    }

    // Final state from the work actually done: all good → done, some failed → partial, all failed →
    // failed, cancelled by the user → cancelled. Published live and stored on the run row.
    const endState = finalState(progress, attempted);
    if (activeRun) finishLiveRun(activeRun, endState, progress);
    // A period is COVERED only when NONE of its queue rows is left un-uploaded — read from the
    // queue, not from this pass's tally: a pass uploads at most MAX_JOBS_PER_PASS files and stops at
    // the first failure, so a period whose files were not reached this pass was recorded `done`
    // with nothing uploaded, and the next tick never looked at it again.
    const outstanding = periodRuns.length ? await outstandingByPeriod(db) : new Map();
    for (const { period, runId } of periodRuns) {
      const t = byPeriod.get(period) ?? { ok: 0, failed: 0 };
      const state: RunState =
        endState === "cancelled"
          ? "cancelled"
          : (outstanding.get(period) ?? 0) === 0
            ? "done"
            : "partial";
      await db
        .update(motardDriveRuns)
        .set({
          state,
          finishedAt: nowIso(),
          progressDone: t.ok + t.failed,
          progressTotal: t.ok + t.failed,
          currentFile: runId === activeRun ? progress.currentFile : null,
          detail: encodeDetail({ ...progress, ...report }),
        })
        .where(eq(motardDriveRuns.id, runId));
    }
    // Everything was archived already and the queue was empty: a second tick does NO work.
    if (!plan.periods.length && attempted === 0 && report.enqueued === 0) {
      report.skipped = "NOTHING_TO_DO";
    }
  } catch (err) {
    // A cancelled run stays cancelled: the operator asked to stop, and that is not a failure.
    // Recording it as 'failed' put a wrong verdict in the run history (remediation B-01).
    const endState: RunState = lastProgress()?.cancelRequested ? "cancelled" : "failed";
    if (report.runId) {
      finishLiveRun(report.runId, endState, lastProgress() ?? newRunProgress("manual", today));
    }
    try {
      if (report.runId) {
        await db
          .update(motardDriveRuns)
          .set({
            state: endState,
            finishedAt: nowIso(),
            progressDone: lastProgress()?.done ?? 0,
            progressTotal: lastProgress()?.total ?? 0,
            currentFile: lastProgress()?.currentFile ?? null,
            detail: String(err).slice(0, 300),
          })
          .where(eq(motardDriveRuns.id, report.runId));
      }
    } catch (writeErr) {
      // Never mask the original failure with a secondary write failure.
      logger.error({ err: writeErr }, "DRIVE_RUN_STATE_WRITE_FAILED");
    }
    throw err;
  } finally {
    passInFlight = false;
  }
  return report;
}

/** Enqueue the newest VERIFIED automatic backup (idempotent by content hash). */
export async function enqueueVerifiedBackupUpload(
  deps: DriveWorkerDeps,
  tenantId: string,
): Promise<{ enqueued: boolean; fileName: string | null }> {
  const newest = verifiedBackups("automatic")[0];
  if (!newest) return { enqueued: false, fileName: null };
  const fileName = newest.path.split(/[\\/]/).pop() ?? "backup.zip";
  // Phase 4: the backup is queued by its streamed hash and size; its bytes are never read whole here.
  const r = await deps.queue.enqueueFile({
    entityType: "db_backup",
    entityId: newest.path,
    // A database backup is a NEW timestamped archive every time, so its identity is its file name.
    documentId: fileName,
    tenantId,
    legacyNamePrefix: null,
    businessDate: newest.createdAt.slice(0, 10),
    section: "system_backups",
    fileName,
    mimeType: "application/zip",
    filePath: newest.path,
    deviceId: deps.localDeviceId ?? "unknown",
  });
  return { enqueued: !r.deduped, fileName: newest.path };
}

export function startDriveArchiveWorker(deps: DriveWorkerDeps): void {
  if (timer) return;
  void runArchivePass(deps, "startup").catch((err) =>
    logger.error({ err }, "DRIVE_ARCHIVE_STARTUP_PASS_FAILED"),
  );
  timer = setInterval(() => {
    void runArchivePass(deps, "timer").catch((err) =>
      logger.error({ err }, "DRIVE_ARCHIVE_TICK_FAILED"),
    );
  }, TICK_MS);
  timer.unref?.();
}

export function stopDriveArchiveWorker(): void {
  if (timer) clearInterval(timer);
  timer = null;
}
