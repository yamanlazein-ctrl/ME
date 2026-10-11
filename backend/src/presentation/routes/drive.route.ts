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
import { motardDriveUploads, motardDriveRuns } from "../../infrastructure/orm/sqlite/schemas/drive-archive.table.js";
import { authorizeUploadDevice, readDriveSettings } from "../../infrastructure/googledrive/coordinator.js";
import { DriveAuthError } from "../../infrastructure/googledrive/driveClient.js";
import type { DriveClient } from "../../infrastructure/googledrive/driveClient.js";
import type { UploadQueue } from "../../infrastructure/googledrive/uploadQueue.js";
import type { DB } from "../../infrastructure/orm/sqlite/drizzleCompat.js";
import { logger } from "../../infrastructure/config/logger.js";

export type DriveRouterDeps = {
  db: DB;
  /** Live Drive client, read per request (a getter in production); null when not connected. */
  driveClient: DriveClient | null;
  /** Local sync device id of THIS device; null when identity not established. */
  localDeviceId: string | null;
  /** Kick the worker loop (manual sync) - primary-device gated upstream. */
  syncNow: (deviceId: string) => Promise<{ queued: number; started: boolean }>;
  queue: UploadQueue;
};

export function createDriveRouter(deps: DriveRouterDeps): Router {
  const router = Router();
  const { db, localDeviceId, queue } = deps;
  // D-02: the repo's own guard over the `req.tenantContext` that authMiddleware sets (the hand-rolled
  // one read a `req.ctx` nothing ever sets, so every call was 401).
  const adminGuard = rbac(["admin"]);

  /** Primary-device gate for state-changing actions - fail-closed. */
  const refuseIfNotPrimary = async (res: Response): Promise<boolean> => {
    if (!localDeviceId) {
      res.status(409).json({ code: "NO_DEVICE_IDENTITY", message: "لا توجد هوية جهاز على هذا التثبيت" });
      return true;
    }
    const decision = await authorizeUploadDevice(db, localDeviceId);
    if (!decision.allowed) {
      logger.warn({ reason: decision.reason }, "drive action refused");
      res.status(403).json({ code: `NOT_PRIMARY_${decision.reason}`, message: "هذا الجهاز ليس جهاز الأرشفة الأساسي" });
      return true;
    }
    return false;
  };

  router.get("/drive/status", adminGuard, async (_req, res) => {
    try {
      const settings = await readDriveSettings(db);
      const rows = await db.select({ status: motardDriveUploads.status, id: motardDriveUploads.id }).from(motardDriveUploads);
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
      const [lastRun] = await db.select().from(motardDriveRuns).orderBy(desc(motardDriveRuns.startedAt)).limit(1);
      res.json({
        archiveEnabled: Boolean(settings.archiveEnabled),
        isPrimaryDevice: Boolean(settings.coordinatorDeviceId && settings.coordinatorDeviceId === localDeviceId),
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
        res.status(401).json({ code: "TOKEN_EXPIRED", message: "انتهت صلاحية التفويض - أعد ربط الحساب" });
        return;
      }
      logger.error({ err }, "drive/test failed");
      res.status(502).json({ code: "GOOGLE_UNREACHABLE", message: "تعذر الوصول إلى Google - تحقق من الاتصال" });
    }
  });

  /** Manual sync - primary device only (backend-enforced, fail-closed). */
  router.post("/drive/sync-now", adminGuard, async (_req, res) => {
    if (await refuseIfNotPrimary(res)) return;
    try {
      const result = await deps.syncNow(localDeviceId!);
      res.json({ ok: true, ...result });
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

  return router;
}
