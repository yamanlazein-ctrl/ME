/**
 * Google Drive archive routes - the only API surface for the settings screen.
 *
 * Security: every route is behind the existing `auth` + admin guards (same as
 * settings). Upload-triggering actions additionally go through
 * `authorizeUploadDevice` (fail-closed): a secondary device may VIEW status
 * and the queue but never start work or retry. No route returns credential
 * material - only connection booleans, the account email (display), and queue
 * statistics. Errors are typed codes with Arabic user messages; internals
 * stay in logs.
 */
import { Router, type Response } from "express";
import { rbac } from "../../infrastructure/http/middleware/rbac.middleware.js";
import { desc, eq } from "drizzle-orm";
import {
  motardDriveUploads,
  motardDriveRuns,
} from "../../infrastructure/orm/sqlite/schemas/drive-archive.table.js";
import {
  authorizeUploadDevice,
  readDriveSettings,
} from "../../infrastructure/googledrive/coordinator.js";
import { DriveAuthError } from "../../infrastructure/googledrive/driveClient.js";
import type { DriveClient } from "../../infrastructure/googledrive/driveClient.js";
import type { UploadQueue } from "../../infrastructure/googledrive/uploadQueue.js";
import type { DB } from "../../infrastructure/orm/sqlite/drizzleCompat.js";
import { logger } from "../../infrastructure/config/logger.js";
import {
  cancelLiveRun,
  getLiveRun,
  percent,
} from "../../infrastructure/googledrive/archiveRuns.js";

export type DriveRouterDeps = {
  db: DB;
  /** Live Drive client, read per request (a getter in production); null when not connected. */
  driveClient: DriveClient | null;
  /** Local sync device id of THIS device; null when identity not established. */
  localDeviceId: string | null;
  /**
   * Start an archive run in the BACKGROUND and answer immediately with its run id. The run then
   * progresses on its own and the client polls `GET /drive/archive/runs/:id`. The route must not
   * await the pass: it can take minutes, and a client timeout would leave the run running with no
   * handle to observe or cancel it.
   */
  startArchiveRun: (
    trigger: "monthly" | "catchup" | "manual" | "connect",
    periodKey?: string,
  ) => Promise<{ runId: string | null; skipped: string | null }>;
  queue: UploadQueue;
};

/** The error list of a finished run, read back from its stored `detail`. */
export function durableErrors(detail: string | null): string[] {
  if (!detail) return [];
  try {
    const v = JSON.parse(detail) as { errors?: unknown };
    return Array.isArray(v.errors)
      ? v.errors.filter((e): e is string => typeof e === "string")
      : [];
  } catch {
    return [detail]; // a failed run stores the failure text, not JSON
  }
}

export function createDriveRouter(deps: DriveRouterDeps): Router {
  const router = Router();
  const { db, localDeviceId, queue } = deps;
  // D-02: the repo's own guard over the `req.tenantContext` that authMiddleware sets (the hand-rolled
  // one read a `req.ctx` nothing ever sets, so every call was 401).
  const adminGuard = rbac(["admin"]);

  /** Primary-device gate for state-changing actions - fail-closed. */
  const refuseIfNotPrimary = async (res: Response): Promise<boolean> => {
    if (!localDeviceId) {
      res
        .status(409)
        .json({ code: "NO_DEVICE_IDENTITY", message: "لا توجد هوية جهاز على هذا التثبيت" });
      return true;
    }
    const decision = await authorizeUploadDevice(db, localDeviceId);
    if (!decision.allowed) {
      logger.warn({ reason: decision.reason }, "drive action refused");
      res.status(403).json({
        code: `NOT_PRIMARY_${decision.reason}`,
        message: "هذا الجهاز ليس جهاز الأرشفة الأساسي",
      });
      return true;
    }
    return false;
  };

  router.get("/drive/status", adminGuard, async (_req, res) => {
    try {
      const settings = await readDriveSettings(db);
      const rows = await db
        .select({ status: motardDriveUploads.status, id: motardDriveUploads.id })
        .from(motardDriveUploads);
      const byStatus = rows.reduce<Record<string, number>>((acc, r) => {
        acc[r.status] = (acc[r.status] ?? 0) + 1;
        return acc;
      }, {});
      const [lastUpload] = await db
        .select({
          uploadedAt: motardDriveUploads.uploadedAt,
          fileName: motardDriveUploads.fileName,
          section: motardDriveUploads.section,
        })
        .from(motardDriveUploads)
        .where(eq(motardDriveUploads.status, "done"))
        .orderBy(desc(motardDriveUploads.uploadedAt))
        .limit(1);
      const [lastRun] = await db
        .select()
        .from(motardDriveRuns)
        .orderBy(desc(motardDriveRuns.startedAt))
        .limit(1);
      res.json({
        archiveEnabled: Boolean(settings.archiveEnabled),
        isPrimaryDevice: Boolean(
          settings.coordinatorDeviceId && settings.coordinatorDeviceId === localDeviceId,
        ),
        coordinatorDeviceId: settings.coordinatorDeviceId ?? null,
        localDeviceId,
        connected: Boolean(deps.driveClient),
        queue: {
          pending: byStatus.pending ?? 0,
          uploading: byStatus.uploading ?? 0,
          done: byStatus.done ?? 0,
          failed: byStatus.failed ?? 0,
          blocked: byStatus.blocked ?? 0,
        },
        lastUpload: lastUpload ?? null,
        lastRun: lastRun ?? null,
      });
    } catch (err) {
      logger.error({ err }, "drive/status failed");
      res.status(500).json({ code: "DRIVE_STATUS_FAILED", message: "تعذر جلب حالة الأرشيف" });
    }
  });

  /** Probe the live Drive connection (requires a valid access token). */
  router.post("/drive/test", adminGuard, async (_req, res) => {
    const driveClient = deps.driveClient; // live: present only while the shell has pushed a token
    if (!driveClient) {
      res.status(409).json({ code: "NOT_CONNECTED", message: "لم يتم ربط حساب Google بعد" });
      return;
    }
    try {
      const ping = await driveClient.ping();
      res.json({ ok: true, email: ping.email });
    } catch (err) {
      if (err instanceof DriveAuthError) {
        res
          .status(401)
          .json({ code: "TOKEN_EXPIRED", message: "انتهت صلاحية التفويض - أعد ربط الحساب" });
        return;
      }
      logger.error({ err }, "drive/test failed");
      res
        .status(502)
        .json({ code: "GOOGLE_UNREACHABLE", message: "تعذر الوصول إلى Google - تحقق من الاتصال" });
    }
  });

  /**
   * Manual sync - primary device only (backend-enforced, fail-closed).
   *
   * The legacy alias of `POST /drive/archive/runs`: same pass, same background behaviour, same run
   * id in the answer. The skip reason is propagated, so "busy", "not connected" and "not the
   * coordinator" are distinguishable instead of all looking like "nothing to do".
   */
  router.post("/drive/sync-now", adminGuard, async (_req, res) => {
    if (await refuseIfNotPrimary(res)) return;
    try {
      const started = await deps.startArchiveRun("manual");
      res.json({ ok: true, ...started });
    } catch (err) {
      logger.error({ err }, "drive/sync-now failed");
      res.status(500).json({ code: "SYNC_FAILED", message: "فشل بدء المزامنة" });
    }
  });

  /** Inspect the queue (any admin, any device - read-only). */
  router.get("/drive/queue", adminGuard, async (req, res) => {
    try {
      const status = typeof req.query.status === "string" ? req.query.status : undefined;
      const base = db
        .select({
          id: motardDriveUploads.id,
          entityType: motardDriveUploads.entityType,
          entityId: motardDriveUploads.entityId,
          periodKey: motardDriveUploads.periodKey,
          section: motardDriveUploads.section,
          fileName: motardDriveUploads.fileName,
          status: motardDriveUploads.status,
          retryCount: motardDriveUploads.retryCount,
          lastError: motardDriveUploads.lastError,
          uploadedAt: motardDriveUploads.uploadedAt,
          createdAt: motardDriveUploads.createdAt,
        })
        .from(motardDriveUploads);
      const jobs = await (status ? base.where(eq(motardDriveUploads.status, status)) : base)
        .orderBy(desc(motardDriveUploads.createdAt))
        .limit(100);
      res.json({ jobs });
    } catch (err) {
      logger.error({ err }, "drive/queue failed");
      res.status(500).json({ code: "QUEUE_FAILED", message: "تعذر جلب قائمة الرفع" });
    }
  });

  /** Retry one failed/blocked job - primary device only. */
  router.post("/drive/queue/:id/retry", adminGuard, async (req, res) => {
    if (await refuseIfNotPrimary(res)) return;
    try {
      await queue.retry(String(req.params.id));
      res.json({ ok: true });
    } catch (err) {
      logger.error({ err }, "drive/retry failed");
      res.status(500).json({ code: "RETRY_FAILED", message: "فشلت إعادة المحاولة" });
    }
  });

  /**
   * Phase 4 — start an archive run. Primary device only. The run continues in the background and
   * the response carries its id, so the client can poll the progress and cancel it.
   */
  router.post("/drive/archive/runs", adminGuard, async (req, res) => {
    if (await refuseIfNotPrimary(res)) return;
    const body = (req.body ?? {}) as { trigger?: unknown; periodKey?: unknown };
    // The trigger is validated, never coerced: an unknown value is a client error (an unknown
    // string used to become "manual" silently).
    const TRIGGERS = ["manual", "monthly", "catchup", "connect"] as const;
    const trigger = TRIGGERS.find((t) => t === body.trigger) ?? "manual";
    if (body.trigger !== undefined && trigger !== body.trigger) {
      res.status(400).json({ code: "VALIDATION", message: "مُشغّل التشغيل غير صالح" });
      return;
    }
    let periodKey: string | undefined;
    if (body.periodKey !== undefined) {
      if (typeof body.periodKey !== "string" || !/^\d{4}-\d{2}$/.test(body.periodKey)) {
        res.status(400).json({ code: "VALIDATION", message: "الفترة غير صالحة" });
        return;
      }
      periodKey = body.periodKey;
    }
    try {
      const started = await deps.startArchiveRun(trigger, periodKey);
      // The run is under way (or was skipped for a reason the client can act on).
      res.status(202).json({ ok: true, ...started });
    } catch (err) {
      logger.error({ err }, "drive/archive/runs start failed");
      res.status(500).json({ code: "SYNC_FAILED", message: "فشل بدء المزامنة" });
    }
  });

  /** Phase 4 — progress of one run, for the progress bar (polled). */
  router.get("/drive/archive/runs/:id", adminGuard, async (req, res) => {
    const runId = String(req.params.id);
    const run = getLiveRun(runId);
    if (!run) {
      // The live map is in memory only: a run that finished before the poll, or before a restart,
      // is read from the durable row instead of answering "not found".
      const [row] = await deps.db
        .select({
          state: motardDriveRuns.state,
          progressDone: motardDriveRuns.progressDone,
          progressTotal: motardDriveRuns.progressTotal,
          currentFile: motardDriveRuns.currentFile,
          periodKey: motardDriveRuns.periodKey,
          trigger: motardDriveRuns.trigger,
          startedAt: motardDriveRuns.startedAt,
          finishedAt: motardDriveRuns.finishedAt,
          detail: motardDriveRuns.detail,
        })
        .from(motardDriveRuns)
        .where(eq(motardDriveRuns.id, runId))
        .limit(1);
      if (!row) {
        res.status(404).json({ code: "RUN_NOT_FOUND", message: "لم يُعثر على التشغيل" });
        return;
      }
      res.json({
        state: row.state,
        progressDone: row.progressDone,
        progressTotal: row.progressTotal,
        percent:
          row.progressTotal === 0 ? 100 : Math.round((row.progressDone / row.progressTotal) * 100),
        currentFile: row.currentFile,
        // The errors outlive the process: a finished run stores its progress (with the error list)
        // as JSON in `detail`, and a run that failed outright stores the failure text itself.
        errors: durableErrors(row.detail),
        periodKey: row.periodKey,
        trigger: row.trigger,
        startedAt: row.startedAt,
        finishedAt: row.finishedAt,
      });
      return;
    }
    res.json({
      state: run.state,
      progressDone: run.progress.done,
      progressTotal: run.progress.total,
      percent: percent(run.progress),
      currentFile: run.progress.currentFile,
      errors: run.progress.errors,
    });
  });

  /** Phase 4 — ask a running run to stop after its current file. Primary device only. */
  router.post("/drive/archive/runs/:id/cancel", adminGuard, async (req, res) => {
    if (await refuseIfNotPrimary(res)) return;
    const ok = cancelLiveRun(String(req.params.id));
    if (!ok) {
      res.status(409).json({ code: "RUN_NOT_RUNNING", message: "التشغيل غير قيد التنفيذ" });
      return;
    }
    res.json({ ok: true });
  });

  return router;
}
