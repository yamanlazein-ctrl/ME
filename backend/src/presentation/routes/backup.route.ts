import { Router, type Request, type Response } from "express";
import { spawnSync } from "child_process";
import { createReadStream, existsSync, readdirSync, statSync } from "fs";
import { join, relative, resolve, sep } from "path";
import { tmpdir } from "os";
import { mkdir, rm, writeFile, copyFile } from "fs/promises";
import { db } from "../../infrastructure/orm/drizzle.js";
import { sql } from "drizzle-orm";
import { logger } from "../../infrastructure/config/logger.js";

const backupInProgress = new Set<string>();

export const backupRouter = Router();

backupRouter.post("/backup/full", async (req: Request, res: Response) => {
  const tenantId = (req as unknown as { tenantContext?: { tenantId?: string } }).tenantContext?.tenantId;
  if (!tenantId) {
    res.status(401).json({ code: "UNAUTHORIZED", message: "غير مصرح" });
    return;
  }
  const role = (req as unknown as { tenantContext?: { userRole?: string } }).tenantContext?.userRole;
  if (role !== "admin") {
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
    await dbDumpToJson(join(tmpDir, "database.json"), tenantId);
    await writeFile(
      join(tmpDir, "backup_info.json"),
      JSON.stringify(
        {
          appName: "Fabric ERP",
          version: process.env.npm_package_version || "1.0.0",
          backupId,
          createdAt: new Date().toISOString(),
          tenantId,
          exportedBy: (req as unknown as { tenantContext?: { userId?: string } }).tenantContext?.userId,
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
    res.setHeader("Content-Disposition", `attachment; filename="fabric-erp-backup-${timestamp}.zip"`);
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
    logger.info({ backupId, tenantId, sizeMB: (stats.size / 1024 / 1024).toFixed(1), durationMs: duration }, "Backup completed");
  } catch (error) {
    logger.error({ backupId, err: (error as Error)?.message }, "Backup failed");
    rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    rm(zipFile, { force: true }).catch(() => {});
    res.status(500).json({ code: "BACKUP_FAILED", message: "فشل إنشاء النسخة الاحتياطية.", details: error instanceof Error ? error.message : String(error) });
  } finally {
    backupInProgress.delete(tenantId);
  }
});

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
    const r = spawnSync(zipCmd, ["-r", "-q", relativeArchive, "."], { cwd: sourceDir, stdio: "pipe" });
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
async function dbDumpToJson(outputPath: string, tenantId: string): Promise<void> {
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
  const esc = (s: string) => s.replace(/'/g, "''").replace(/"/g, '""');
  for (const table of tenantTables) {
    try {
      const raw = table === "tenants"
        ? `SELECT * FROM "tenants" WHERE id = '${esc(tenantId)}'`
        : `SELECT * FROM "${esc(table)}" WHERE tenant_id = '${esc(tenantId)}'`;
      const result = (await db.execute(sql.raw(raw))) as unknown as { rows: unknown[] };
      dump[table] = result.rows as unknown[];
    } catch {
      dump[table] = [];
    }
  }
  await writeFile(outputPath, JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), tenantId, tables: dump }, null, 2));
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
