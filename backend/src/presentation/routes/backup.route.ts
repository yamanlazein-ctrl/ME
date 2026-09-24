import { Router, type Request, type Response } from "express";
import { createReadStream, createWriteStream, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { mkdir, rm } from "fs/promises";
import { randomUUID } from "crypto";
import { pipeline } from "stream/promises";
import { pool } from "../../infrastructure/orm/drizzle.js";
import { config } from "../../infrastructure/config/env.js";
import { logger } from "../../infrastructure/config/logger.js";
import type { TenantContext, PaginatedResult } from "../../domain/types/index.js";
import type { IInvoiceRepository } from "../../application/ports/IInvoiceRepository.js";
import type { IVoucherRepository } from "../../application/ports/IVoucherRepository.js";
import type { IPartyRepository } from "../../application/ports/IPartyRepository.js";
import type { IStatementRepository } from "../../application/ports/IStatementRepository.js";
import {
  BackupError,
  createPortableBackup,
  openAndVerifyBackup,
  restorePortableBackup,
  type BackupManifest,
} from "../../infrastructure/backup/portableBackup.js";
import { resolveMigrationsFolder } from "../../infrastructure/orm/runDesktopMigrations.js";

const backupInProgress = new Set<string>();
let restoreInProgress = false;

/** Largest backup accepted for verify/restore uploads. */
const MAX_UPLOAD_BYTES = 4 * 1024 * 1024 * 1024;

export interface BackupRouteDeps {
  invoiceRepo: IInvoiceRepository;
  voucherRepo: IVoucherRepository;
  partyRepo: IPartyRepository;
  statementRepo: IStatementRepository;
}

export function appVersion(): string {
  return process.env.MOTARD_APP_VERSION || process.env.npm_package_version || "unknown";
}

function stampNow(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/** Where local automatic/safety backups live (next to the data folder on desktop). */
export function localBackupsRoot(): string {
  const integrity = process.env.DATA_INTEGRITY_PATH;
  if (integrity) return join(integrity, "..", "backups");
  return join(process.env.LOG_DIR ?? ".", "..", "backups");
}

function manifestSummary(m: BackupManifest) {
  return {
    createdAt: m.createdAt,
    appVersion: m.app.version,
    schemaMigrations: m.schema.migrationsApplied,
    postgres: m.postgres.version,
    company: m.tenant.name,
    tables: m.tables.length,
    rows: m.tables.reduce((a, t) => a + t.rows, 0),
    rowsByTable: Object.fromEntries(m.tables.map((t) => [t.name, t.rows])),
  };
}

/** Stream an octet-stream request body to a temp file (never buffered in memory). */
async function receiveUpload(req: Request): Promise<string> {
  const file = join(tmpdir(), `motard-upload-${randomUUID()}.zip`);
  let bytes = 0;
  req.on("data", (chunk: Buffer) => {
    bytes += chunk.length;
    if (bytes > MAX_UPLOAD_BYTES) req.destroy(new Error("الملف أكبر من الحد المسموح"));
  });
  await pipeline(req, createWriteStream(file));
  if (bytes === 0) {
    await rm(file, { force: true });
    throw new BackupError("BACKUP_CORRUPT", "لم يصل أي ملف");
  }
  return file;
}

function sendBackupError(res: Response, err: unknown) {
  if (err instanceof BackupError) {
    const status = err.code === "RESTORE_CONFIRM_REQUIRED" ? 409 : err.code === "RESTORE_FAILED" ? 500 : 422;
    res.status(status).json({ code: err.code, message: err.message, statusCode: status });
    return;
  }
  logger.error({ err }, "backup/restore failed");
  res.status(500).json({
    code: "RESTORE_FAILED",
    message: `فشلت العملية ولم تتغير البيانات الحالية: ${err instanceof Error ? err.message : String(err)}`,
    statusCode: 500,
  });
}

/**
 * Full portable backup of one company to `outZip` (format v2, see
 * infrastructure/backup/portableBackup.ts). Shared by the HTTP endpoint, the
 * automatic scheduler and the pre-restore safety copy.
 */
export async function runTenantFullBackup(
  tenantId: string,
  outZip: string,
): Promise<
  | { ok: true; rowCounts: Record<string, number>; manifest: BackupManifest }
  | { ok: false; warnings: Array<{ table: string; code?: string; message: string }> }
> {
  try {
    const manifest = await createPortableBackup({
      connect: () => pool.connect(),
      tenantId,
      outFile: outZip,
      appVersion: appVersion(),
      logoDir: process.env.COMPANY_LOGO_DIR ?? null,
    });
    return {
      ok: true,
      manifest,
      rowCounts: Object.fromEntries(manifest.tables.map((t) => [t.name, t.rows])),
    };
  } catch (err) {
    return { ok: false, warnings: [{ table: "*", message: err instanceof Error ? err.message : String(err) }] };
  }
}

/** Restore into `targetTenantId`. Used by the admin endpoint and the first-run wizard. */
export async function restoreUploadedBackup(file: string, targetTenantId: string, confirmReplace: boolean) {
  if (restoreInProgress) throw new BackupError("RESTORE_FAILED", "استعادة أخرى قيد التنفيذ");
  restoreInProgress = true;
  try {
    return await restorePortableBackup({
      databaseUrl: config.DATABASE_URL,
      migrationsFolder: resolveMigrationsFolder(),
      file,
      targetTenantId,
      confirmReplace,
      logoDir: process.env.COMPANY_LOGO_DIR ?? null,
      safetyBackup: async () => {
        const dir = localBackupsRoot();
        await mkdir(dir, { recursive: true });
        const out = join(dir, `before-restore-${stampNow()}.zip`);
        const r = await runTenantFullBackup(targetTenantId, out);
        if (!r.ok) throw new BackupError("RESTORE_FAILED", `تعذّر أخذ نسخة أمان قبل الاستعادة: ${r.warnings[0]?.message}`);
        return out;
      },
      log: (m) => logger.info({ targetTenantId }, `[restore] ${m}`),
    });
  } finally {
    restoreInProgress = false;
  }
}

export function createBackupRouter(_deps: BackupRouteDeps): Router {
  const backupRouter = Router();

  // POST /api/backup/full — download a complete, verifiable backup (.zip)
  backupRouter.post("/backup/full", async (req: Request, res: Response) => {
    const ctx = (req as unknown as { tenantContext?: TenantContext }).tenantContext;
    const tenantId = ctx?.tenantId;
    if (!tenantId) {
      res.status(401).json({ code: "UNAUTHORIZED", message: "غير مصرح" });
      return;
    }
    if (ctx.userRole !== "admin") {
      res.status(403).json({ code: "FORBIDDEN", message: "غير مصرح" });
      return;
    }
    if (backupInProgress.has(tenantId)) {
      res.status(429).json({ code: "BACKUP_IN_PROGRESS", message: "نسخة احتياطية قيد التشغيل" });
      return;
    }
    backupInProgress.add(tenantId);
    const startTime = Date.now();
    const date = new Date().toISOString().slice(0, 10);
    const zipFile = join(tmpdir(), `motard-backup-${tenantId}-${stampNow()}.zip`);
    try {
      const r = await runTenantFullBackup(tenantId, zipFile);
      if (!r.ok) {
        res.status(500).json({
          code: "BACKUP_INCOMPLETE",
          message: "فشلت النسخة الاحتياطية — لم يُنشأ أي ملف.",
          warnings: r.warnings,
        });
        return;
      }
      // Self-check before handing the file out: a backup nobody can restore is
      // worse than none, because it looks like protection.
      await openAndVerifyBackup(zipFile);
      const stats = statSync(zipFile);
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Length", stats.size);
      res.setHeader("Content-Disposition", `attachment; filename="MotardERP-Backup-${date}.zip"`);
      res.setHeader("X-Backup-Rows", String(r.manifest.tables.reduce((a, t) => a + t.rows, 0)));
      const stream = createReadStream(zipFile);
      stream.on("close", () => void rm(zipFile, { force: true }).catch(() => {}));
      stream.pipe(res);
      logger.info(
        { tenantId, sizeMB: (stats.size / 1024 / 1024).toFixed(1), durationMs: Date.now() - startTime },
        "Backup completed",
      );
      try {
        const { readManifest, writeManifestAtomic } = await import(
          "../../infrastructure/integrity/dataIntegrityManifest.js"
        );
        const m = await readManifest();
        if (m) await writeManifestAtomic({ ...m, lastSuccessfulBackupAt: new Date().toISOString() });
      } catch (err) {
        logger.warn({ err }, "failed to stamp lastSuccessfulBackupAt");
      }
    } catch (error) {
      await rm(zipFile, { force: true }).catch(() => {});
      sendBackupError(res, error);
    } finally {
      backupInProgress.delete(tenantId);
    }
  });

  // POST /api/backup/verify — check an archive without touching any data
  backupRouter.post("/backup/verify", async (req: Request, res: Response) => {
    let file: string | null = null;
    try {
      file = await receiveUpload(req);
      const { manifest } = await openAndVerifyBackup(file);
      res.json({ ok: true, ...manifestSummary(manifest) });
    } catch (err) {
      sendBackupError(res, err);
    } finally {
      if (file) await rm(file, { force: true }).catch(() => {});
    }
  });

  // POST /api/backup/restore?confirm=replace — replace this company's data
  backupRouter.post("/backup/restore", async (req: Request, res: Response) => {
    const ctx = (req as unknown as { tenantContext?: TenantContext }).tenantContext;
    if (!ctx?.tenantId || ctx.userRole !== "admin") {
      res.status(403).json({ code: "FORBIDDEN", message: "غير مصرح" });
      return;
    }
    if (!config.DESKTOP_DEPLOY) {
      res.status(400).json({ code: "NOT_SUPPORTED", message: "الاستعادة من الواجهة متاحة في نسخة سطح المكتب فقط" });
      return;
    }
    let file: string | null = null;
    try {
      file = await receiveUpload(req);
      const report = await restoreUploadedBackup(file, ctx.tenantId, req.query.confirm === "replace");
      res.json(report);
    } catch (err) {
      sendBackupError(res, err);
    } finally {
      if (file) await rm(file, { force: true }).catch(() => {});
    }
  });

  return backupRouter;
}

export async function fetchAllPages<T>(
  fetchPage: (page: number) => Promise<PaginatedResult<T>>,
): Promise<T[]> {
  const all: T[] = [];
  let page = 0;
  for (;;) {
    const res = await fetchPage(page);
    all.push(...res.data);
    if (!res.meta.hasNext) break;
    page += 1;
  }
  return all;
}

/** Windows/NTFS-safe file stem from a document number/name. */
export function safeFileStem(raw: string): string {
  const cleaned = raw.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "_").trim();
  return (cleaned || "بدون-رقم").slice(0, 150);
}
