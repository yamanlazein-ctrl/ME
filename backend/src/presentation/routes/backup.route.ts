import { Router, type Request, type Response } from "express";
import { execSync } from "child_process";
import { createReadStream, existsSync, readdirSync, statSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { mkdir, rm, writeFile, copyFile, readFile } from "fs/promises";
import { db } from "../../infrastructure/orm/drizzle.js";
import { sql } from "drizzle-orm";

/**
 * Full Backup API — يُصدّر نسخة احتياطية كاملة للمشروع كملف ZIP
 *
 * POST /api/backup/full
 *
 * يُنشئ ملف ZIP يحتوي:
 *   1. database_dump.sql (أو database.json إذا pg_dump غير متاح)
 *   2. backup_info.json (معلومات النسخة)
 *   3. uploads/ (الملفات المرفوعة إذا موجودة)
 *
 * Response: stream ZIP (download)
 */
export const backupRouter = Router();

backupRouter.post("/backup/full", async (req: Request, res: Response) => {
  const startTime = Date.now();
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const backupId = `backup-${timestamp}`;
  const tmpDir = join(tmpdir(), backupId);
  const zipFile = join(tmpdir(), `${backupId}.zip`);

  try {
    await mkdir(tmpDir, { recursive: true });

    // ─── 1. قاعدة البيانات ──────────────────────────────────────────
    const pgDumpPath = findPgDump();
    const dbFile = join(tmpDir, "database_dump.sql");

    if (pgDumpPath) {
      execSync(
        `${pgDumpPath} --no-owner --no-privileges --format=plain --clean --if-exists ` +
        `"${process.env.DATABASE_URL ?? ""}" > "${dbFile}"`,
        { stdio: "pipe", timeout: 300000, maxBuffer: 100 * 1024 * 1024 },
      );
    } else {
      await dbDumpToJson(join(tmpDir, "database.json"));
    }

    // ─── 2. ملف معلومات النسخة ─────────────────────────────────────
    await writeFile(
      join(tmpDir, "backup_info.json"),
      JSON.stringify({
        appName: "Fabric ERP",
        version: process.env.npm_package_version || "1.0.0",
        backupId,
        createdAt: new Date().toISOString(),
        tenantId: req.tenantContext?.tenantId,
        exportedBy: req.tenantContext?.userId,
        method: pgDumpPath ? "pg_dump" : "json_dump",
        databaseUrl: (process.env.DATABASE_URL ?? "").replace(/:.*@/, ":***@"),
      }, null, 2),
    );

    // ─── 3. الملفات المرفوعة ───────────────────────────────────────
    const uploadsDir = resolve("./uploads");
    if (existsSync(uploadsDir)) {
      await copyDirRecursive(uploadsDir, join(tmpDir, "uploads"));
    }

    // ─── 4. ضغط ZIP (باستخدام zip command إذا متاح، وإلا tar) ──────
    await createArchive(tmpDir, zipFile);

    const stats = statSync(zipFile);
    const duration = Date.now() - startTime;

    // ─── 5. إرسال الملف ───────────────────────────────────────────
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
      console.error("[Backup] Stream error:", err);
      if (!res.headersSent) res.status(500).end();
    });
    stream.pipe(res);

    console.log(`[Backup] ${backupId} | ${(stats.size / 1024 / 1024).toFixed(1)} MB | ${duration}ms`);
  } catch (error) {
    console.error("[Backup] Failed:", error);
    rm(tmpDir, { recursive: true, force: true }).catch(() => {});
    rm(zipFile, { force: true }).catch(() => {});
    res.status(500).json({
      code: "BACKUP_FAILED",
      message: "فشل إنشاء النسخة الاحتياطية. تحقق من صلاحيات قاعدة البيانات ومساحة القرص.",
      details: error instanceof Error ? error.message : String(error),
    });
  }
});

// ─── Helpers ───────────────────────────────────────────────────────────

function findPgDump(): string | null {
  try {
    execSync("pg_dump --version", { stdio: "pipe" });
    return "pg_dump";
  } catch {
    const paths = ["/usr/bin/pg_dump", "/usr/local/bin/pg_dump", "/opt/homebrew/bin/pg_dump"];
    for (const p of paths) { if (existsSync(p)) return p; }
    return null;
  }
}

function findZip(): string | null {
  try {
    execSync("zip --version", { stdio: "pipe" });
    return "zip";
  } catch {
    const paths = ["/usr/bin/zip", "/usr/local/bin/zip"];
    for (const p of paths) { if (existsSync(p)) return p; }
    return null;
  }
}

function findTar(): string | null {
  try {
    execSync("tar --version", { stdio: "pipe" });
    return "tar";
  } catch {
    return null;
  }
}

async function createArchive(sourceDir: string, outputFile: string): Promise<void> {
  const zipCmd = findZip();
  if (zipCmd) {
    execSync(`${zipCmd} -r -q "${outputFile}" .`, { cwd: sourceDir, stdio: "pipe" });
    return;
  }
  const tarCmd = findTar();
  if (tarCmd) {
    execSync(`${tarCmd} czf "${outputFile}" .`, { cwd: sourceDir, stdio: "pipe" });
    return;
  }
  throw new Error("Neither 'zip' nor 'tar' command found. Install one to create archives.");
}

async function dbDumpToJson(outputPath: string): Promise<void> {
  const tables = [
    "tenants", "users", "parties", "fabrics", "colors", "rolls",
    "invoices", "invoice_lines", "orders", "order_items",
    "vouchers", "ledger_entries", "cashbox_entries", "expenses",
    "returns", "return_lines", "print_jobs", "audit_logs",
    "notifications", "settings", "document_sequences",
    "stock_movements", "idempotency_keys",
    "party_balances", "ledger_entry_archive", "yearly_party_summaries",
  ];

  const dump: Record<string, unknown[]> = {};

  for (const table of tables) {
    try {
      const rows = await db.execute(sql.raw(`SELECT * FROM "${table}"`));
      dump[table] = rows.rows as unknown[];
    } catch {
      dump[table] = [];
    }
  }

  await writeFile(
    outputPath,
    JSON.stringify({ version: 1, exportedAt: new Date().toISOString(), tables: dump }, null, 2),
  );
}

async function copyDirRecursive(src: string, dest: string): Promise<void> {
  await mkdir(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) {
      await copyDirRecursive(srcPath, destPath);
    } else {
      await copyFile(srcPath, destPath);
    }
  }
}
