import { Router, type Request, type Response } from "express";
import { createReadStream, createWriteStream, existsSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { mkdir, rm } from "fs/promises";
import { randomUUID } from "crypto";
import { pipeline } from "stream/promises";
import { config } from "../../infrastructure/config/env.js";
import { logger } from "../../infrastructure/config/logger.js";
import type { TenantContext, PaginatedResult } from "../../domain/types/index.js";
import type { IInvoiceRepository } from "../../application/ports/IInvoiceRepository.js";
import type { IVoucherRepository } from "../../application/ports/IVoucherRepository.js";
import type { IPartyRepository } from "../../application/ports/IPartyRepository.js";
import type { IStatementRepository } from "../../application/ports/IStatementRepository.js";
import type { BackupManifest } from "../../infrastructure/backup/portableBackup.js";
import { BackupError } from "../../infrastructure/backup/backupError.js";
import { getEngine } from "../../infrastructure/orm/engine.js";

/**
 * Desktop SQLite (specs/001-desktop-sqlite-engine T095/T098): every backup goes through the v3
 * createAndVerifyBackup path and every restore through the staged v3 restore. The PostgreSQL v2
 * implementation (cloud, unchanged) is loaded lazily so a SQLite process never evaluates it.
 */
const isSqlite = () => getEngine() === "sqlite";
const v2 = () => import("../../infrastructure/backup/portableBackup.js");
const pgPoolLazy = async () => (await import("../../infrastructure/orm/pgLazy.js")).pgPool();

/** v3 errors → the same HTTP error contract the screens already handle. */
async function asBackupError(err: unknown): Promise<unknown> {
  const { BackupV3Error } = await import("../../infrastructure/backup/sqliteBackup.js");
  const { RestoreError } = await import("../../infrastructure/backup/sqliteRestore.js");
  // restoreBackupV3 wraps an archive refusal (PostgreSQL-era, newer, corrupt) in a RestoreError at
  // VERIFY_ARCHIVE: map the underlying refusal, so the user gets its specific message and code.
  if (err instanceof RestoreError && err.step === "VERIFY_ARCHIVE" && err.cause instanceof BackupV3Error) err = err.cause;
  if (err instanceof BackupV3Error) {
    const code =
      err.code === "BACKUP_NEWER_THAN_APP" || err.code === "BACKUP_SCHEMA_NEWER_THAN_APP"
        ? "BACKUP_NEWER_THAN_APP"
        : err.code === "BACKUP_POSTGRES_ERA" || err.code === "BACKUP_FORMAT_UNKNOWN"
          ? "BACKUP_UNSUPPORTED_FORMAT"
          : "BACKUP_CORRUPT";
    const msg =
      err.code === "BACKUP_POSTGRES_ERA"
        ? "هذه نسخة احتياطية من إصدار PostgreSQL السابق (PostgreSQL-era backup) ولا يمكن استعادتها في هذا الإصدار"
        : err.message;
    return new BackupError(code, msg);
  }
  if (err instanceof RestoreError) {
    return new BackupError(err.step === "VERIFY_ARCHIVE" ? "RESTORE_VERIFY_FAILED" : "RESTORE_FAILED", `فشلت الاستعادة ولم تتغير البيانات الحالية: ${err.message}`);
  }
  return err;
}

import { localToday } from "../../infrastructure/utils/localDate.js";
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
    const { createPortableBackup } = await v2();
    const pool = await pgPoolLazy();
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
    if (isSqlite()) {
      // Same confirmation contract as v2: replacing a company that already has data needs confirm=replace.
      const { sqliteDb } = await import("../../infrastructure/orm/sqlite/transaction.js");
      const { sql } = await import("drizzle-orm");
      const has = await sqliteDb().execute<{ n: number }>(
        sql`SELECT (SELECT count(*) FROM invoices WHERE tenant_id = ${targetTenantId}) + (SELECT count(*) FROM parties WHERE tenant_id = ${targetTenantId}) AS n`,
      );
      if (!confirmReplace && Number(has.rows[0]?.n ?? 0) > 0) {
        throw new BackupError("RESTORE_CONFIRM_REQUIRED", "توجد بيانات حالية — أكّد الاستبدال للمتابعة (ستُحفظ نسخة أمان أولاً)");
      }
      const { restoreBackupV3 } = await import("../../infrastructure/backup/sqliteRestore.js");
      try {
        return await restoreBackupV3(file);
      } catch (err) {
        throw await asBackupError(err);
      }
    }
    const { restorePortableBackup } = await v2();
    const { resolveMigrationsFolder } = await import("../../infrastructure/orm/runDesktopMigrations.js");
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
    const date = localToday();
    if (isSqlite()) {
      try {
        // A manual v3 backup: created, VERIFIED and registered in <root>\backups, then streamed.
        const { createAndVerifyBackup } = await import("../../infrastructure/backup/sqliteBackup.js");
        const created = await createAndVerifyBackup({ kind: "manual", appVersion: appVersion() });
        if (req.query.deliver === "metadata") {
          // T100 (I-11): the desktop bridge carries text only, so the desktop window never receives the
          // zip bytes — it asks for the VERIFIED file's identity and the shell copies the file itself
          // (save_backup_file), re-checking size + sha256 against these values.
          res.json({
            status: "VERIFIED",
            fileName: `MotardERP-Backup-${date}.zip`,
            path: created.path,
            sizeBytes: created.sizeBytes,
            sha256: created.sha256,
            rows: created.manifest.tables.reduce((a, t) => a + t.rows, 0),
          });
          logger.info({ tenantId, path: created.path, durationMs: Date.now() - startTime }, "Backup completed (v3, VERIFIED, metadata)");
          return;
        }
        res.setHeader("Content-Type", "application/zip");
        res.setHeader("Content-Length", created.sizeBytes);
        res.setHeader("Content-Disposition", `attachment; filename="MotardERP-Backup-${date}.zip"`);
        res.setHeader("X-Backup-Rows", String(created.manifest.tables.reduce((a, t) => a + t.rows, 0)));
        res.setHeader("X-Backup-Sha256", created.sha256);
        res.setHeader("X-Backup-Path", encodeURIComponent(created.path));
        createReadStream(created.path).pipe(res);
        logger.info({ tenantId, path: created.path, durationMs: Date.now() - startTime }, "Backup completed (v3, VERIFIED)");
      } catch (error) {
        sendBackupError(res, await asBackupError(error));
      } finally {
        backupInProgress.delete(tenantId);
      }
      return;
    }
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
      await (await v2()).openAndVerifyBackup(zipFile);
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
  // GET /api/backup/registry — desktop SQLite only (T100): the backups.json entries, newest first,
  // so the settings page can show VERIFIED / FAILED. Anything else answers 404.
  backupRouter.get("/backup/registry", async (req: Request, res: Response) => {
    const ctx = (req as unknown as { tenantContext?: TenantContext }).tenantContext;
    if (!ctx?.tenantId) {
      res.status(401).json({ code: "UNAUTHORIZED", message: "غير مصرح" });
      return;
    }
    if (ctx.userRole !== "admin") {
      res.status(403).json({ code: "FORBIDDEN", message: "غير مصرح" });
      return;
    }
    if (!isSqlite()) {
      res.status(404).json({ code: "NOT_FOUND", message: "غير متاح" });
      return;
    }
    const { readRegistry } = await import("../../infrastructure/backup/backupRegistry.js");
    const entries = readRegistry()
      .entries.filter((e) => e.status !== "CREATING")
      .map((e) => ({
        path: e.path,
        kind: e.kind,
        createdAt: e.createdAt,
        status: e.status,
        sizeBytes: e.sizeBytes ?? null,
        sha256: e.sha256 ?? null,
        error: e.error ?? null,
        exists: existsSync(e.path),
        lastRestoreTest: e.lastRestoreTest ?? null,
      }))
      .sort((x, y) => (x.createdAt < y.createdAt ? 1 : x.createdAt > y.createdAt ? -1 : 0));
    res.json({ entries });
  });

  backupRouter.post("/backup/verify", async (req: Request, res: Response) => {
    let file: string | null = null;
    try {
      file = await receiveUpload(req);
      if (isSqlite()) {
        const { openAndVerifyBackupV3 } = await import("../../infrastructure/backup/sqliteBackup.js");
        try {
          const { manifest } = await openAndVerifyBackupV3(file);
          res.json({
            ok: true,
            createdAt: manifest.createdAt,
            appVersion: manifest.app.version,
            schemaMigrations: manifest.schema.journalIdx,
            company: manifest.tenant.name,
            tables: manifest.tables.length,
            rows: manifest.tables.reduce((a, t) => a + t.rows, 0),
            rowsByTable: Object.fromEntries(manifest.tables.map((t) => [t.name, t.rows])),
            formatVersion: manifest.formatVersion,
          });
        } catch (err) {
          throw await asBackupError(err);
        }
        return;
      }
      const { manifest } = await (await v2()).openAndVerifyBackup(file);
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
