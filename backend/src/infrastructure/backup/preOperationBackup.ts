/**
 * BK-4 pre-operation backups (specs/001-desktop-sqlite-engine T097).
 *
 * Before a year close, a year reopen, a party purge, a dye purge or a party merge on the SQLite
 * desktop, a VERIFIED v3 backup (kind "pre-operation") is created. If it cannot be created the
 * operation does not run (nothing has changed yet). Restores make their own "pre-restore" backup
 * inside restoreBackupV3. PostgreSQL / cloud: unchanged — this is a no-op.
 *
 * Called from the route AFTER the request is validated and BEFORE the transaction starts: the
 * backup takes the write gate itself and must never run inside a transaction.
 */
import type { Response } from "express";
import { getEngine } from "../orm/engine.js";
import { logger } from "../config/logger.js";

export type PreOperation = "year-close" | "year-reopen" | "party-purge" | "dye-purge" | "party-merge";

export class PreOperationBackupError extends Error {
  readonly code = "PRE_OPERATION_BACKUP_FAILED";
  constructor(
    readonly operation: PreOperation,
    readonly cause: unknown,
  ) {
    super(`pre-operation backup before ${operation} failed: ${cause instanceof Error ? cause.message : String(cause)}`);
  }
}

/** The VERIFIED backup's path on SQLite; null on PostgreSQL. Throws PreOperationBackupError. */
export async function preOperationBackup(operation: PreOperation): Promise<string | null> {
  if (getEngine() !== "sqlite") return null;
  try {
    const { createAndVerifyBackup } = await import("./sqliteBackup.js");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const created = await createAndVerifyBackup({
      kind: "pre-operation",
      fileName: `pre-operation-${operation}-${stamp}.zip`,
      appVersion: process.env.MOTARD_APP_VERSION,
    });
    logger.info({ operation, path: created.path }, "PRE_OPERATION_BACKUP_VERIFIED");
    return created.path;
  } catch (err) {
    logger.error({ err, operation }, "PRE_OPERATION_BACKUP_FAILED");
    throw new PreOperationBackupError(operation, err);
  }
}

/** The answer when the backup failed: the operation was not run and nothing changed. */
export function sendPreOperationBackupFailure(res: Response, err: PreOperationBackupError): Response {
  return res.status(503).json({
    code: err.code,
    message: "تعذّر إنشاء نسخة احتياطية موثَّقة قبل هذه العملية، لذلك لم تُنفَّذ. لم يتغيّر أي شيء. تحقّق من المساحة الحرّة على القرص ثم أعد المحاولة.",
  });
}

/**
 * Run the backup and answer the failure in one step: returns true when the caller may proceed,
 * false when the response has already been sent.
 */
export async function guardWithPreOperationBackup(res: Response, operation: PreOperation): Promise<boolean> {
  try {
    await preOperationBackup(operation);
    return true;
  } catch (err) {
    if (err instanceof PreOperationBackupError) {
      sendPreOperationBackupFailure(res, err);
      return false;
    }
    throw err;
  }
}
