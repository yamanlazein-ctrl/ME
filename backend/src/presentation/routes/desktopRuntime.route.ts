/**
 * Runtime-only endpoints for the desktop shell (specs/001-desktop-sqlite-engine T083, D-1).
 *
 * Reached only over the desktop named pipe, only on the SQLite engine, and only by the Rust runtime:
 * every call carries `X-Motard-Runtime-Token` = sha256(APP_MASTER_KEY), a value the runtime holds in
 * its DPAPI store and the UI never sees. Anything else answers 404 (the routes do not exist for it).
 *
 *   POST /api/desktop/runtime/pre-update-backup  → a VERIFIED v3 backup, kind "pre-update", recorded in
 *                                                   backups.json; the update is blocked if this fails
 *   POST /api/desktop/runtime/shutdown           → wait for in-flight writes, WAL checkpoint(TRUNCATE),
 *                                                   close, exit — so the update replaces nothing in use
 *   POST /api/desktop/runtime/drive-token        → the shell's Google access token for the Drive archive
 *                                                   (memory only; `null` clears it on disconnect)
 *   GET  /api/desktop/runtime/archive-render-requests → the documents the backend wants rendered
 *   POST /api/desktop/runtime/archive-artifact   → the rendered file the shell staged
 */
import type { Router, Request, Response } from "express";
import { createHash, timingSafeEqual } from "node:crypto";
import { getEngine } from "../../infrastructure/orm/engine.js";
import { logger } from "../../infrastructure/config/logger.js";

function runtimeAuthorized(req: Request): boolean {
  if (process.env.DESKTOP_DEPLOY !== "true" || getEngine() !== "sqlite") return false;
  const key = process.env.APP_MASTER_KEY;
  const given = String(req.headers["x-motard-runtime-token"] ?? "");
  if (!key || !given) return false;
  const expected = createHash("sha256").update(key).digest("hex");
  const a = Buffer.from(given);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

export function registerDesktopRuntimeRoutes(router: Router): void {
  router.post("/api/desktop/runtime/pre-update-backup", async (req: Request, res: Response) => {
    if (!runtimeAuthorized(req))
      return res.status(404).json({ code: "NOT_FOUND", message: "المسار غير موجود" });
    try {
      const { createAndVerifyBackup } = await import("../../infrastructure/backup/sqliteBackup.js");
      const created = await createAndVerifyBackup({
        kind: "pre-update",
        appVersion: process.env.MOTARD_APP_VERSION,
      });
      logger.info({ path: created.path }, "PRE_UPDATE_BACKUP_VERIFIED");
      return res.json({
        ok: true,
        path: created.path,
        sha256: created.sha256,
        sizeBytes: created.sizeBytes,
      });
    } catch (err) {
      logger.error({ err }, "PRE_UPDATE_BACKUP_FAILED");
      return res.status(500).json({
        code: "PRE_UPDATE_BACKUP_FAILED",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // Google Drive (audit D-01): the shell pushes a short-lived access token after connect, on every
  // refresh and `null` on disconnect. The refresh token never leaves the shell; this one is kept in
  // memory only and never echoed or logged.
  router.post("/api/desktop/runtime/drive-token", async (req: Request, res: Response) => {
    if (!runtimeAuthorized(req))
      return res.status(404).json({ code: "NOT_FOUND", message: "المسار غير موجود" });
    const { accessToken, expiresAt } = (req.body ?? {}) as {
      accessToken?: unknown;
      expiresAt?: unknown;
    };
    const { setLiveDriveToken } = await import("../../infrastructure/googledrive/driveClient.js");
    if (accessToken === null) {
      setLiveDriveToken(null);
      return res.json({ ok: true, connected: false });
    }
    if (
      typeof accessToken !== "string" ||
      accessToken.length < 16 ||
      typeof expiresAt !== "number" ||
      !Number.isFinite(expiresAt)
    ) {
      return res.status(400).json({ code: "VALIDATION", message: "رمز Google غير صالح" });
    }
    setLiveDriveToken(accessToken, expiresAt);
    return res.json({ ok: true, connected: true });
  });

  // ── The render channel (Stage 3, E-14) ────────────────────────────────────────────────────────────
  // The backend owns the documents; the shell owns the renderer. The shell PULLS the work from
  // here and posts the rendered file back, because it is the shell that has a channel to the
  // backend — not the other way round.
  router.get(
    "/api/desktop/runtime/archive-render-requests",
    async (req: Request, res: Response) => {
      if (!runtimeAuthorized(req)) {
        return res.status(404).json({ code: "NOT_FOUND", message: "المسار غير موجود" });
      }
      try {
        const { sqliteDb } = await import("../../infrastructure/orm/sqlite/transaction.js");
        const { pendingRenders } = await import("../../infrastructure/googledrive/renderBridge.js");
        const requests = await pendingRenders(sqliteDb());
        return res.json({ ok: true, requests });
      } catch (err) {
        logger.error({ err }, "runtime/archive-render-requests failed");
        return res
          .status(500)
          .json({ code: "RENDER_REQUESTS_FAILED", message: "تعذر جلب طلبات التصيير" });
      }
    },
  );

  router.post("/api/desktop/runtime/archive-artifact", async (req: Request, res: Response) => {
    if (!runtimeAuthorized(req)) {
      return res.status(404).json({ code: "NOT_FOUND", message: "المسار غير موجود" });
    }
    const body = (req.body ?? {}) as {
      requestId?: unknown;
      path?: unknown;
      sha256?: unknown;
      sizeBytes?: unknown;
      error?: unknown;
    };
    if (typeof body.requestId !== "string" || !body.requestId) {
      return res.status(400).json({ code: "VALIDATION", message: "معرّف الطلب غير صالح" });
    }
    try {
      const { sqliteDb } = await import("../../infrastructure/orm/sqlite/transaction.js");
      const { completeRender } = await import("../../infrastructure/googledrive/renderBridge.js");
      const rendered = await completeRender(sqliteDb(), body.requestId, {
        path: typeof body.path === "string" ? body.path : undefined,
        sha256: typeof body.sha256 === "string" ? body.sha256 : undefined,
        sizeBytes: typeof body.sizeBytes === "number" ? body.sizeBytes : undefined,
        error: typeof body.error === "string" ? body.error : undefined,
      });
      return res.json({ ok: true, rendered });
    } catch (err) {
      logger.error({ err }, "runtime/archive-artifact failed");
      return res
        .status(500)
        .json({ code: "RENDER_ARTIFACT_FAILED", message: "تعذر تسجيل الملف المُنتج" });
    }
  });

  router.post("/api/desktop/runtime/shutdown", async (req: Request, res: Response) => {
    if (!runtimeAuthorized(req))
      return res.status(404).json({ code: "NOT_FOUND", message: "المسار غير موجود" });
    try {
      const { withWriteGateHeld } = await import("../../infrastructure/orm/sqlite/transaction.js");
      const { shutdownSqliteRuntime } = await import("../../infrastructure/orm/sqlite/runtime.js");
      // No transaction can be in flight while the gate is held; close = wal_checkpoint(TRUNCATE).
      await withWriteGateHeld(() => shutdownSqliteRuntime());
      logger.info("DESKTOP_SHUTDOWN_CHECKPOINTED");
      res.json({ ok: true, checkpointed: true });
      res.on("finish", () => setTimeout(() => process.exit(0), 50));
    } catch (err) {
      logger.error({ err }, "DESKTOP_SHUTDOWN_FAILED");
      res.status(500).json({
        code: "SHUTDOWN_FAILED",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
