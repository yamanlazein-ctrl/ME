import { Router, type Request, type Response } from "express";
import { spawnSync } from "child_process";
import { createReadStream, existsSync, readdirSync, statSync } from "fs";
import { join, relative, resolve, sep } from "path";
import { tmpdir } from "os";
import { mkdir, rm, writeFile, copyFile } from "fs/promises";
import { db } from "../../infrastructure/orm/drizzle.js";
import { sql } from "drizzle-orm";
import { logger } from "../../infrastructure/config/logger.js";
import type { TenantContext, PaginatedResult } from "../../domain/types/index.js";
import type { IInvoiceRepository } from "../../application/ports/IInvoiceRepository.js";
import type { IVoucherRepository } from "../../application/ports/IVoucherRepository.js";
import type { IPartyRepository } from "../../application/ports/IPartyRepository.js";
import type { IStatementRepository } from "../../application/ports/IStatementRepository.js";

const backupInProgress = new Set<string>();

export interface BackupRouteDeps {
  invoiceRepo: IInvoiceRepository;
  voucherRepo: IVoucherRepository;
  partyRepo: IPartyRepository;
  statementRepo: IStatementRepository;
}

export function createBackupRouter(deps: BackupRouteDeps): Router {
  const backupRouter = Router();

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
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const backupId = `backup-${tenantId}-${timestamp}`;
    const tmpDir = join(tmpdir(), backupId);
    const zipFile = join(tmpdir(), `${backupId}.zip`);
    try {
      await mkdir(tmpDir, { recursive: true });
      const dumpResult = await dbDumpToJson(join(tmpDir, "database.json"), tenantId);
      // REPAIR-028 A: never report success when any table dump failed.
      if (dumpResult.warnings.length > 0) {
        await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
        await rm(zipFile, { force: true }).catch(() => {});
        res.status(500).json({
          code: "BACKUP_INCOMPLETE",
          message: "فشلت النسخة الاحتياطية — جدول واحد أو أكثر لم يُصدَّر بالكامل.",
          warnings: dumpResult.warnings,
        });
        return;
      }
      const { createHash } = await import("node:crypto");
      const dbJson = await import("node:fs/promises").then((fs) =>
        fs.readFile(join(tmpDir, "database.json")),
      );
      const sha256 = createHash("sha256").update(dbJson).digest("hex");
      // metadata.json — restore verification (REPAIR-028)
      await writeFile(
        join(tmpDir, "metadata.json"),
        JSON.stringify(
          {
            operationId: backupId,
            tenantId,
            schemaJournalIdx: null,
            createdAt: new Date().toISOString(),
            rowCounts: dumpResult.rowCounts,
            sha256,
            appVersion: process.env.npm_package_version || "1.0.0",
          },
          null,
          2,
        ),
      );
      // Human-browsable folders alongside the technical dump above — the dump
      // stays the restore source of truth (`npm run db:restore` reads only
      // `database.json`); these are purely additive read copies per document.
      await buildDocumentFolders(deps, tmpDir, ctx).catch((err) => {
        logger.error(
          { backupId, tenantId, err: err instanceof Error ? err.message : String(err) },
          "[Backup] Failed to build document folders — continuing with database.json only",
        );
      });
      await writeFile(
        join(tmpDir, "backup_info.json"),
        JSON.stringify(
          {
            appName: "Fabric ERP",
            version: process.env.npm_package_version || "1.0.0",
            backupId,
            createdAt: new Date().toISOString(),
            tenantId,
            exportedBy: ctx.userId,
            method: "json_dump_tenant_scoped",
          },
          null,
          2,
        ),
      );
      const uploadsDir = resolve("./uploads");
      if (existsSync(uploadsDir)) await copyDirRecursive(uploadsDir, join(tmpDir, "uploads"));
      await createArchive(tmpDir, zipFile);
      const stats = statSync(zipFile);
      const duration = Date.now() - startTime;
      res.setHeader("Content-Type", "application/zip");
      res.setHeader("Content-Length", stats.size);
      res.setHeader(
        "Content-Disposition",
        `attachment; filename="fabric-erp-backup-${timestamp}.zip"`,
      );
      const stream = createReadStream(zipFile);
      stream.on("end", () => {
        setTimeout(() => {
          rm(tmpDir, { recursive: true, force: true }).catch(() => {});
          rm(zipFile, { force: true }).catch(() => {});
        }, 300000);
      });
      stream.on("error", (err) => {
        logger.error({ backupId, err: err.message }, "[Backup] Stream error");
        if (!res.headersSent) res.status(500).end();
      });
      stream.pipe(res);
      logger.info(
        { backupId, tenantId, sizeMB: (stats.size / 1024 / 1024).toFixed(1), durationMs: duration },
        "Backup completed",
      );
      try {
        const { readManifest, writeManifestAtomic } = await import(
          "../../infrastructure/integrity/dataIntegrityManifest.js"
        );
        const m = await readManifest();
        if (m) {
          await writeManifestAtomic({
            ...m,
            lastSuccessfulBackupAt: new Date().toISOString(),
          });
        }
      } catch (err) {
        logger.warn({ err }, "failed to stamp lastSuccessfulBackupAt");
      }
    } catch (error) {
      logger.error({ backupId, err: (error as Error)?.message }, "Backup failed");
      rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      rm(zipFile, { force: true }).catch(() => {});
      res
        .status(500)
        .json({
          code: "BACKUP_FAILED",
          message: "فشل إنشاء النسخة الاحتياطية.",
          details: error instanceof Error ? error.message : String(error),
        });
    } finally {
      backupInProgress.delete(tenantId);
    }
  });

  return backupRouter;
}

function findZip(): string | null {
  const r = spawnSync("zip", ["--version"], { stdio: "pipe" });
  if (r.status === 0) return "zip";
  for (const p of ["/usr/bin/zip", "/usr/local/bin/zip"]) if (existsSync(p)) return p;
  return null;
}
function findTar(): string | null {
  const r = spawnSync("tar", ["--version"], { stdio: "pipe" });
  if (r.status === 0) return "tar";
  return null;
}
async function createArchive(sourceDir: string, outputFile: string): Promise<void> {
  // GNU tar reads `-f C:\...` as a REMOTE `host:path` spec and dies with
  // "tar (child): Cannot connect to C: resolve failed" (reproduced live on
  // Windows with Git's tar first on PATH, which made POST /api/backup/full
  // return 500). Pass the archive as a path RELATIVE to the cwd we already run
  // in — both GNU tar and bsdtar accept it, and it can never be mistaken for
  // `host:path`. The archive still lands in the same (temp) directory.
  const relativeArchive = relative(sourceDir, outputFile).split(sep).join("/");
  const zipCmd = findZip();
  if (zipCmd) {
    const r = spawnSync(zipCmd, ["-r", "-q", relativeArchive, "."], {
      cwd: sourceDir,
      stdio: "pipe",
    });
    if (r.status !== 0) throw new Error(`zip failed: ${r.stderr?.toString()}`);
    return;
  }
  const tarCmd = findTar();
  if (tarCmd) {
    const r = spawnSync(tarCmd, ["czf", relativeArchive, "."], { cwd: sourceDir, stdio: "pipe" });
    if (r.status !== 0) throw new Error(`tar failed: ${r.stderr?.toString()}`);
    return;
  }
  throw new Error("Neither 'zip' nor 'tar' command found.");
}
async function dbDumpToJson(
  outputPath: string,
  tenantId: string,
): Promise<{
  warnings: Array<{ table: string; code?: string; message: string }>;
  rowCounts: Record<string, number>;
}> {
  const tenantTables = [
    "tenants",
    "users",
    "parties",
    "fabrics",
    "colors",
    "rolls",
    "invoices",
    "invoice_lines",
    "orders",
    "order_items",
    "vouchers",
    "ledger_entries",
    "expenses",
    "returns",
    "return_lines",
    "print_jobs",
    "audit_logs",
    "notifications",
    "settings",
    "document_sequences",
    "stock_movements",
    "idempotency_keys",
    "ledger_entry_archive",
    "yearly_party_summaries",
    // Full-coverage additions: cashbox trio + attachment metadata + company
    // profile. Without these a restored system loses cashbox sessions,
    // manual movements, attachment links and the company identity.
    "cashbox_sessions",
    "day_closes",
    "manual_movements",
    "attachments",
    "company_profiles",
    // Sync state (docs/SYNC-OPERATIONS.md backup/restore): a restore that drops the outbox
    // loses not-yet-pushed local operations; dropping the inbox + cursor
    // forces peers to replay everything; dropping claims resurrects
    // double-spend; dropping tombstones resurrects deleted master rows.
    // Tables created only in newer schemas dump as [] via the catch below.
    "sync_outbox",
    "sync_inbox",
    "sync_state",
    "sync_devices",
    "sync_resource_claims",
    "sync_tombstones",
    "sync_conflicts",
    "document_number_blocks",
  ];
  const dump: Record<string, unknown[]> = {};
  // Real query failures used to be indistinguishable from "this table simply
  // has zero rows for this tenant" — both produced `[]` with no trace
  // anywhere, so a backup could silently ship without e.g. invoices and look
  // completely successful. Only a genuinely missing table (older schema,
  // before a table was added — see the sync_* comment below) is expected;
  // everything else is now logged AND recorded in the dump itself.
  const warnings: Array<{ table: string; code?: string; message: string }> = [];
  const rowCounts: Record<string, number> = {};
  const esc = (s: string) => s.replace(/'/g, "''").replace(/"/g, '""');
  for (const table of tenantTables) {
    try {
      const raw =
        table === "tenants"
          ? `SELECT * FROM "tenants" WHERE id = '${esc(tenantId)}'`
          : `SELECT * FROM "${esc(table)}" WHERE tenant_id = '${esc(tenantId)}'`;
      const result = (await db.execute(sql.raw(raw))) as unknown as { rows: unknown[] };
      dump[table] = result.rows as unknown[];
      rowCounts[table] = result.rows.length;
    } catch (err) {
      const code = (err as { code?: string } | undefined)?.code;
      const message = err instanceof Error ? err.message : String(err);
      dump[table] = [];
      rowCounts[table] = 0;
      if (code === "42P01") continue; // undefined_table: expected on an older schema.
      warnings.push({ table, code, message });
      logger.error(
        { tenantId, table, code, message },
        "[Backup] Table dump query failed — exported as empty array, see warnings in database.json",
      );
    }
  }
  await writeFile(
    outputPath,
    JSON.stringify(
      { version: 1, exportedAt: new Date().toISOString(), tenantId, tables: dump, warnings },
      null,
      2,
    ),
  );
  return { warnings, rowCounts };
}

/**
 * REPAIR-028 B — shared path for HTTP backup and automatic scheduler.
 * Writes a ZIP to `outZipPath`. Returns ok:false when warnings present.
 */
export async function runTenantFullBackup(
  tenantId: string,
  outZipPath: string,
): Promise<
  | { ok: true; rowCounts: Record<string, number> }
  | { ok: false; warnings: Array<{ table: string; code?: string; message: string }> }
> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const tmpDir = join(tmpdir(), `auto-backup-${tenantId}-${timestamp}`);
  try {
    await mkdir(tmpDir, { recursive: true });
    const dumpResult = await dbDumpToJson(join(tmpDir, "database.json"), tenantId);
    if (dumpResult.warnings.length > 0) {
      await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
      return { ok: false, warnings: dumpResult.warnings };
    }
    const { createHash } = await import("node:crypto");
    const dbJson = await import("node:fs/promises").then((fs) =>
      fs.readFile(join(tmpDir, "database.json")),
    );
    const sha256 = createHash("sha256").update(dbJson).digest("hex");
    await writeFile(
      join(tmpDir, "metadata.json"),
      JSON.stringify(
        {
          operationId: `auto-${timestamp}`,
          tenantId,
          createdAt: new Date().toISOString(),
          rowCounts: dumpResult.rowCounts,
          sha256,
          appVersion: process.env.npm_package_version || "1.0.0",
        },
        null,
        2,
      ),
    );
    await createArchive(tmpDir, outZipPath);
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    return { ok: true, rowCounts: dumpResult.rowCounts };
  } catch (err) {
    await rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    throw err;
  }
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

async function writeOneJsonPerDocument(
  root: string,
  folderName: string,
  documents: Array<{ id: string; number?: string | null }>,
): Promise<void> {
  const dir = join(root, folderName);
  await mkdir(dir, { recursive: true });
  for (const doc of documents) {
    const stem = safeFileStem(doc.number || doc.id);
    await writeFile(join(dir, `${stem}.json`), JSON.stringify(doc, null, 2), "utf8");
  }
}

/**
 * Human-browsable copy of the backup, organized exactly like the customer
 * expects to find their paperwork: one JSON file per document, grouped into
 * folders by document type — separate from `database.json` (the technical,
 * full-fidelity restore source).
 */
async function buildDocumentFolders(
  deps: BackupRouteDeps,
  root: string,
  ctx: TenantContext,
): Promise<void> {
  const [entryInvoices, saleInvoices, receipts, payments, parties] = await Promise.all([
    fetchAllPages((page) => deps.invoiceRepo.list({ type: "entry", page, limit: 1000 }, ctx)),
    fetchAllPages((page) => deps.invoiceRepo.list({ type: "sale", page, limit: 1000 }, ctx)),
    fetchAllPages((page) => deps.voucherRepo.list({ kind: "receipt", page, limit: 1000 }, ctx)),
    fetchAllPages((page) => deps.voucherRepo.list({ kind: "payment", page, limit: 1000 }, ctx)),
    fetchAllPages((page) => deps.partyRepo.list({ page, limit: 1000 }, ctx)),
  ]);

  await Promise.all([
    writeOneJsonPerDocument(root, "فواتير دخول", entryInvoices),
    writeOneJsonPerDocument(root, "فواتير خروج", saleInvoices),
    writeOneJsonPerDocument(root, "سندات القبض", receipts),
    writeOneJsonPerDocument(root, "سندات الصرف", payments),
  ]);

  const statementsDir = join(root, "كشوفات الحسابات");
  await mkdir(statementsDir, { recursive: true });
  for (const party of parties) {
    try {
      const statement = await deps.statementRepo.getStatement(
        { partyId: party.id, kind: party.kind },
        ctx,
      );
      // Skip a party with zero balance and zero movements — an empty
      // statement file for every never-used party would just be noise.
      if (statement.entries.length === 0 && statement.previousBalance === 0) continue;
      const stem = safeFileStem(party.code || party.name || party.id);
      await writeFile(
        join(statementsDir, `${stem}.json`),
        JSON.stringify(statement, null, 2),
        "utf8",
      );
    } catch (err) {
      logger.warn(
        { partyId: party.id, err: err instanceof Error ? err.message : String(err) },
        "[Backup] Failed to build statement for a party — skipped, backup continues",
      );
    }
  }
}
async function copyDirRecursive(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) await copyDirRecursive(srcPath, destPath);
    else await copyFile(srcPath, destPath);
  }
}
