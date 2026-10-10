import { Router, type Request, type Response } from "express";
import { createReadStream, createWriteStream, existsSync, readFileSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { mkdir, rm } from "fs/promises";
import { createHash, randomUUID } from "crypto";
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
    // Preserve the SPECIFIC refusal code. Collapsing every archive refusal into BACKUP_CORRUPT is what
    // made the UI show one generic "ملف غير صالح" for genuinely different situations: an unsupported
    // format, a newer app version, a missing manifest, a bad checksum and a missing database are all
    // distinct, actionable failures. The wire contract keeps BACKUP_CORRUPT as the fallback for codes
    // no screen special-cases, so existing clients are unchanged.
    const KNOWN_V3_CODES = new Set([
      "BACKUP_NOT_A_ZIP",
      "BACKUP_MANIFEST_MISSING",
      "BACKUP_MANIFEST_HASH_MISMATCH",
      "BACKUP_DATABASE_MISSING",
      "BACKUP_FILE_HASH_MISMATCH",
      "BACKUP_INTEGRITY_FAILED",
      "BACKUP_FOREIGN_KEYS_FAILED",
      "BACKUP_TABLE_MISMATCH",
      "BACKUP_FILE_MISSING",
      "BACKUP_NO_FILE_RECEIVED",
    ]);
    const code =
      err.code === "BACKUP_NEWER_THAN_APP" || err.code === "BACKUP_SCHEMA_NEWER_THAN_APP"
        ? "BACKUP_NEWER_THAN_APP"
        : err.code === "BACKUP_POSTGRES_ERA" || err.code === "BACKUP_FORMAT_UNKNOWN"
          ? "BACKUP_UNSUPPORTED_FORMAT"
          : KNOWN_V3_CODES.has(err.code)
            ? err.code
            : "BACKUP_CORRUPT";
    const msg =
      err.code === "BACKUP_POSTGRES_ERA"
        ? "هذه نسخة احتياطية من إصدار PostgreSQL السابق (format v2) ولا يمكن استعادتها في هذا الإصدار — صدّر نسخة جديدة من إصدار حديث."
        : err.code === "BACKUP_NEWER_THAN_APP"
          ? `هذه النسخة الاحتياطية أُنشئت بإصدار أحدث من البرنامج المثبَّت (${err.message}). حدّث البرنامج أولًا ثم أعد الاستعادة.`
          : err.code === "BACKUP_SCHEMA_NEWER_THAN_APP"
            ? `قاعدة البيانات داخل هذه النسخة تحتوي ترحيلات أحدث من إصدار البرنامج المثبَّت (${err.message}). حدّث البرنامج أولًا.`
            : err.code === "BACKUP_NOT_A_ZIP"
              ? "الملف المختار ليس أرشيف ZIP صالحًا — قد يكون ناقص التنزيل أو تالفًا. أعد تنزيل النسخة أو اختر ملفًا آخر."
              : err.code === "BACKUP_MANIFEST_MISSING"
                ? "الأرشيف لا يحتوي على ملف معلومات صالح (manifest.json) — قد يكون أرشيف نسخة احتياطية سابقة بصيغة مختلفة."
                : err.code === "BACKUP_MANIFEST_HASH_MISMATCH"
                  ? "بصمة ملف المعلومات لا تطابق محتواه — الأرشيف تالف أو عُدِّل. لا يمكن الاستعادة منه."
                  : err.code === "BACKUP_DATABASE_MISSING"
                    ? "الأرشيف لا يحتوي على قاعدة البيانات (database.sqlite) — الأرشيف ناقص."
                    : err.code === "BACKUP_FILE_HASH_MISMATCH"
                      ? `أحد ملفات الأرشيف لا يطابق بصمته المسجّلة (${err.message}) — الأرشيف تالف.`
                      : err.code === "BACKUP_INTEGRITY_FAILED"
                        ? `قاعدة البيانات داخل الأرشيف لم تجتز فحص السلامة (${err.message}).`
                        : err.code === "BACKUP_FOREIGN_KEYS_FAILED"
                          ? `قاعدة البيانات داخل الأرشيف تحتوي ارتباطات غير متسقة (${err.message}).`
                          : err.code === "BACKUP_TABLE_MISMATCH"
                            ? `محتوى الأرشيف لا يطابق ملف المعلومات (${err.message}) — الأرشيف تالف أو ناقص.`
                            : err.message;
    return new BackupError(code, msg);
  }
  if (err instanceof RestoreError) {
    return new BackupError(err.step === "VERIFY_ARCHIVE" ? "RESTORE_VERIFY_FAILED" : "RESTORE_FAILED", `فشلت الاستعادة ولم تتغير البيانات الحالية: ${err.message}`);
  }
  // Already a BackupError (the hand-off refusals above): pass it through with its own code and message
  // so the UI can tell "no file arrived" from "the archive is damaged".
  if (err instanceof BackupError) return err;
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
    // Distinguish "nothing was sent at all" from "a zero-byte file was chosen": on the desktop the
    // former is what the text-only IPC bridge produces when a `File` body is dropped, and the caller
    // must be told the transfer failed rather than that the archive is damaged.
    throw new BackupError(
      "BACKUP_NO_FILE_RECEIVED",
      "لم يصل أي ملف إلى الخادم — تعذّر نقل الملف. أعد اختيار الملف من جديد.",
    );
  }
  return file;
}

/**
 * Desktop-only: accept an archive the shell already placed on disk, instead of an octet-stream body.
 *
 * WHY: the desktop SPA is embedded in the binary and reaches this API over the Tauri IPC bridge, whose
 * request body is a `String` (`desktop/src-tauri/src/runtime/pipe.rs`: `PipeRequest.body`). A `File`
 * cannot cross it — the patched `fetch` (`src/infrastructure/http/desktopTransport.ts`) therefore drops
 * every non-string body, `receiveUpload` sees zero bytes and answers "لم يصل أي ملف" for a perfectly
 * valid archive. The bridge is text-only BY DESIGN, so the file is handed over as a PATH (exactly how
 * `save_backup_file` already delivers a backup outward) and re-verified here from its own bytes.
 *
 * The path is NOT trusted: size + sha256 are recomputed on this side and compared with what the shell
 * reported, and the archive then goes through the same `openAndVerifyBackupV3` / `restoreBackupV3` the
 * upload path uses. A tampered, truncated or substituted file is refused before anything is swapped.
 */
async function receiveShellPath(req: Request): Promise<{ path: string; reportedSha256: string | null; reportedSize: number | null }> {
  const body = (req.body ?? {}) as { path?: unknown; sha256?: unknown; sizeBytes?: unknown };
  const path = typeof body.path === "string" ? body.path.trim() : "";
  if (!path) throw new BackupError("BACKUP_CORRUPT", "لم يُحدَّد مسار ملف النسخة الاحتياطية");
  const reportedSha256 = typeof body.sha256 === "string" && /^[0-9a-f]{64}$/i.test(body.sha256) ? body.sha256 : null;
  const reportedSize = typeof body.sizeBytes === "number" && Number.isFinite(body.sizeBytes) && body.sizeBytes > 0 ? body.sizeBytes : null;
  if (!existsSync(path)) throw new BackupError("BACKUP_FILE_MISSING", `الملف غير موجود: ${path}`);
  const st = statSync(path);
  if (!st.isFile()) throw new BackupError("BACKUP_FILE_MISSING", `المسار ليس ملفًا: ${path}`);
  if (st.size === 0) throw new BackupError("BACKUP_CORRUPT", "الملف المحدد فارغ");
  if (reportedSize !== null && st.size !== reportedSize) {
    throw new BackupError("BACKUP_FILE_HASH_MISMATCH", `حجم الملف لا يطابق النسخة المختارة (${st.size} مقابل ${reportedSize} بايت)`);
  }
  if (reportedSha256 !== null) {
    const actual = createHash("sha256").update(readFileSync(path)).digest("hex");
    if (actual !== reportedSha256.toLowerCase()) {
      throw new BackupError("BACKUP_FILE_HASH_MISMATCH", "بصمة الملف لا تطابق النسخة المختارة — قد يكون الملف تغيّر بعد اختياره");
    }
  }
  return { path, reportedSha256, reportedSize };
}

/**
 * The newest SQLite migration index this build can apply.
 *
 * Used by BOTH verify and restore so the two agree: verify must not report "✓ سليم" for an archive
 * whose schema the app cannot apply, only for the restore to refuse it a moment later. `restoreBackupV3`
 * already enforces this (`openAndVerifyBackupV3Sync(file, { maxJournalIdx })`); verify simply never
 * passed it, which let the card show a green check for a backup that could never be restored.
 */
async function appMaxJournalIdx(): Promise<number | undefined> {
  try {
    const { sqliteRuntimeMigrationsDir } = await import("../../infrastructure/orm/sqlite/runtime.js");
    const { loadSqliteJournal } = await import("../../infrastructure/orm/sqlite/schemaFingerprint.js");
    return loadSqliteJournal(sqliteRuntimeMigrationsDir()).entries.at(-1)!.idx;
  } catch {
    return undefined; // not a SQLite build (cloud/v2) — the gate does not apply
  }
}

function sendBackupError(res: Response, err: unknown) {
  if (err instanceof BackupError) {
    // 404 when the chosen file is gone (the user can pick another), 400 when nothing was transferred at
    // all (a client/transport problem, not a damaged archive), 409 when confirmation is still needed.
    const status =
      err.code === "RESTORE_CONFIRM_REQUIRED"
        ? 409
        : err.code === "RESTORE_FAILED"
          ? 500
          : err.code === "BACKUP_FILE_MISSING"
            ? 404
            : err.code === "BACKUP_NO_FILE_RECEIVED"
              ? 400
              : 422;
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

  /**
   * POST /api/backup/verify-path — desktop verify, by path instead of by upload.
   *
   * The desktop SPA reaches this API over the Tauri IPC bridge, whose request body is a `String`
   * (`desktop/src-tauri/src/runtime/pipe.rs`: `PipeRequest.body`). A `File` cannot cross it, so the
   * patched `fetch` (src/infrastructure/http/desktopTransport.ts) drops every non-string body and the
   * server sees zero bytes — which is exactly why a valid archive was reported as "لم يصل أي ملف".
   * The bridge is text-only by design, so the file is handed over as a PATH with the size and sha256
   * the shell measured, and this route re-verifies both from the file's own bytes before running the
   * exact same `openAndVerifyBackupV3` the upload path uses.
   */
  backupRouter.post("/backup/verify-path", async (req: Request, res: Response) => {
    try {
      const { path } = await receiveShellPath(req); // size/sha256 re-checked from the file's own bytes
      if (isSqlite()) {
        const { openAndVerifyBackupV3 } = await import("../../infrastructure/backup/sqliteBackup.js");
        try {
          const { manifest } = await openAndVerifyBackupV3(path, { maxJournalIdx: await appMaxJournalIdx() });
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
      const { manifest } = await (await v2()).openAndVerifyBackup(path);
      res.json({ ok: true, ...manifestSummary(manifest) });
    } catch (err) {
      sendBackupError(res, err);
    }
  });

  backupRouter.post("/backup/verify", async (req: Request, res: Response) => {
    let file: string | null = null;
    try {
      file = await receiveUpload(req);
      if (isSqlite()) {
        const { openAndVerifyBackupV3 } = await import("../../infrastructure/backup/sqliteBackup.js");
        try {
          const { manifest } = await openAndVerifyBackupV3(file, { maxJournalIdx: await appMaxJournalIdx() });
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

  /**
   * POST /api/backup/verify-path — the desktop verify, by path instead of by upload.
   * The SPA's `File` cannot cross the text-only IPC bridge, so the shell picks the archive, reports its
   * size + sha256, and this route re-verifies both before opening the archive. Same verification
   * (`openAndVerifyBackupV3`) and the same response shape as `/backup/verify`.
   */
  backupRouter.post("/backup/verify-path", async (req: Request, res: Response) => {
    try {
      const { path } = await receiveShellPath(req); // size/sha256 re-checked from the file's own bytes
      if (isSqlite()) {
        const { openAndVerifyBackupV3 } = await import("../../infrastructure/backup/sqliteBackup.js");
        try {
          const { manifest } = await openAndVerifyBackupV3(path, { maxJournalIdx: await appMaxJournalIdx() });
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
      const { manifest } = await (await v2()).openAndVerifyBackup(path);
      res.json({ ok: true, ...manifestSummary(manifest) });
    } catch (err) {
      sendBackupError(res, err);
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

  /**
   * POST /api/backup/restore-path?confirm=replace — the desktop restore, by path instead of by upload.
   * Everything after the hand-off is identical to `/backup/restore`: the same `restoreUploadedBackup`,
   * so the same v3 verification, safety backup, staging migration, RS-5 comparison, device-state
   * carry-over and atomic swap. The archive itself is only ever READ, never moved or deleted.
   */
  backupRouter.post("/backup/restore-path", async (req: Request, res: Response) => {
    const ctx = (req as unknown as { tenantContext?: TenantContext }).tenantContext;
    if (!ctx?.tenantId || ctx.userRole !== "admin") {
      res.status(403).json({ code: "FORBIDDEN", message: "غير مصرح" });
      return;
    }
    if (!config.DESKTOP_DEPLOY) {
      res.status(400).json({ code: "NOT_SUPPORTED", message: "الاستعادة من الواجهة متاحة في نسخة سطح المكتب فقط" });
      return;
    }
    try {
      const { path } = await receiveShellPath(req);
      const report = await restoreUploadedBackup(path, ctx.tenantId, req.query.confirm === "replace");
      res.json(report);
    } catch (err) {
      sendBackupError(res, err);
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
