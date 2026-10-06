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
    if (!runtimeAuthorized(req)) return res.status(404).json({ code: "NOT_FOUND", message: "المسار غير موجود" });
    try {
      const { createAndVerifyBackup } = await import("../../infrastructure/backup/sqliteBackup.js");
      const created = await createAndVerifyBackup({ kind: "pre-update", appVersion: process.env.MOTARD_APP_VERSION });
      logger.info({ path: created.path }, "PRE_UPDATE_BACKUP_VERIFIED");
      return res.json({ ok: true, path: created.path, sha256: created.sha256, sizeBytes: created.sizeBytes });
    } catch (err) {
      logger.error({ err }, "PRE_UPDATE_BACKUP_FAILED");
      return res.status(500).json({ code: "PRE_UPDATE_BACKUP_FAILED", message: err instanceof Error ? err.message : String(err) });
    }
  });

  router.post("/api/desktop/runtime/shutdown", async (req: Request, res: Response) => {
    if (!runtimeAuthorized(req)) return res.status(404).json({ code: "NOT_FOUND", message: "المسار غير موجود" });
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
      res.status(500).json({ code: "SHUTDOWN_FAILED", message: err instanceof Error ? err.message : String(err) });
    }
  });
}
