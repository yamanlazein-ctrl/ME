/**
 * REPAIR-028 B — desktop automatic backup scheduler.
 * Daily after 02:00 local, or at boot if last success > 24h.
 * Writes a real ZIP via shared dump helpers when a default tenant exists.
 */
import { mkdir, readdir, rm, stat, writeFile, copyFile, rename } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, dirname, basename } from "node:path";
import { tmpdir, homedir } from "os";
import { logger } from "../config/logger.js";
import { config } from "../config/env.js";
import {
  readManifest,
  writeManifestAtomic,
} from "../integrity/dataIntegrityManifest.js";
import { pgDb } from "../orm/pgLazy.js";
import { sql } from "drizzle-orm";

let timer: NodeJS.Timeout | null = null;
let running = false;

function backupsRoot(): string {
  const integrity = process.env.DATA_INTEGRITY_PATH;
  if (integrity) return join(dirname(integrity), "backups");
  return join(process.env.LOG_DIR ?? ".", "..", "backups");
}

/**
 * Second copy OUTSIDE the app data folder. Deleting %LOCALAPPDATA%\motard-erp
 * (manually, an uninstaller "remove leftovers" pass, a cleanup tool) must not
 * take the only backups with it. Override with BACKUP_MIRROR_DIR; "off"
 * disables the mirror.
 */
export function backupMirrorRoot(): string | null {
  const env = process.env.BACKUP_MIRROR_DIR?.trim();
  if (env === "off") return null;
  if (env) return env;
  return join(homedir(), "Documents", "Motard ERP Backups");
}

const KEEP_BACKUPS = 7;

export async function pruneOldZips(dir: string, keep = KEEP_BACKUPS): Promise<void> {
  // Names embed an ISO timestamp (auto-2026-09-23T02-00-00-000Z.zip), so name
  // order IS chronological — mtime is not (Windows copies keep the source mtime).
  // Only our own automatic files: the mirror lives in the user's Documents,
  // where a manually saved backup (any other .zip) must never be pruned.
  const files = (await readdir(dir))
    .filter((f) => f.startsWith("auto-") && f.endsWith(".zip"))
    .sort()
    .reverse();
  for (const f of files.slice(keep)) {
    await rm(join(dir, f), { force: true }).catch(() => {});
  }
}

/**
 * A backup only ever carries its final `auto-*.zip` name once it is complete:
 * written under `.partial`, then renamed (atomic on the same volume). Closing
 * the app / a power cut mid-write used to leave a truncated `auto-*.zip` that
 * looked like a backup and counted toward the 7 kept — pushing out a good one.
 */
async function removeStalePartials(dir: string): Promise<void> {
  const files = await readdir(dir).catch(() => [] as string[]);
  for (const f of files) {
    if (f.startsWith("auto-") && f.endsWith(".partial")) await rm(join(dir, f), { force: true }).catch(() => {});
  }
}

export async function mirrorBackup(zipPath: string): Promise<string | null> {
  const dir = backupMirrorRoot();
  if (!dir) return null;
  try {
    await mkdir(dir, { recursive: true });
    await removeStalePartials(dir);
    const target = join(dir, basename(zipPath));
    await copyFile(zipPath, `${target}.partial`);
    await rename(`${target}.partial`, target);
    await pruneOldZips(dir);
    return target;
  } catch (err) {
    // A mirror failure never fails the primary backup.
    logger.warn({ err, dir }, "BACKUP_MIRROR_FAILED");
    return null;
  }
}

async function lastBackupAgeMs(): Promise<number | null> {
  const m = await readManifest();
  if (m?.lastSuccessfulBackupAt) {
    return Date.now() - new Date(m.lastSuccessfulBackupAt).getTime();
  }
  return null;
}

async function resolveDefaultTenantId(): Promise<string | null> {
  if (process.env.DEFAULT_TENANT_ID) return process.env.DEFAULT_TENANT_ID;
  try {
    const r = await (await pgDb()).execute(
      sql`SELECT id::text AS id FROM tenants WHERE slug = 'default' LIMIT 1`,
    );
    const rows = (r as unknown as { rows: Array<{ id: string }> }).rows ?? [];
    return rows[0]?.id ?? null;
  } catch {
    return null;
  }
}

async function runAutomaticBackup(): Promise<void> {
  if (running) return;
  running = true;
  try {
    const root = backupsRoot();
    await mkdir(root, { recursive: true });
    const tenantId = await resolveDefaultTenantId();
    if (!tenantId) {
      logger.warn("AUTO_BACKUP_SKIPPED: no default tenant");
      return;
    }

    const { runTenantFullBackup } = await import("../../presentation/routes/backup.route.js");
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const outZip = join(root, `auto-${stamp}.zip`);
    await removeStalePartials(root);
    const result = await runTenantFullBackup(tenantId, `${outZip}.partial`);
    if (!result.ok) {
      logger.error({ warnings: result.warnings }, "AUTO_BACKUP_INCOMPLETE");
      await rm(`${outZip}.partial`, { force: true }).catch(() => {});
      return;
    }
    await rename(`${outZip}.partial`, outZip);

    const m = await readManifest();
    if (m) {
      await writeManifestAtomic({
        ...m,
        lastSuccessfulBackupAt: new Date().toISOString(),
      });
    }
    const mirrored = await mirrorBackup(outZip);
    logger.info({ outZip, mirrored, bootId: process.env.MOTARD_BOOT_ID }, "AUTO_BACKUP_OK");
    await pruneOldZips(root);
  } catch (err) {
    logger.error({ err }, "automatic backup failed");
  } finally {
    running = false;
  }
}

export function startBackupScheduler(): void {
  if (!config.DESKTOP_DEPLOY) return;
  if (timer) return;

  const tick = async () => {
    const age = await lastBackupAgeMs();
    const hour = new Date().getHours();
    const dueByAge = age === null || age > 24 * 60 * 60 * 1000;
    const dueBySchedule = hour >= 2 && hour < 4;
    if (dueByAge || dueBySchedule) {
      await runAutomaticBackup();
    }
  };

  void tick();
  timer = setInterval(() => void tick(), 30 * 60 * 1000);
  timer.unref?.();
  logger.info("backup scheduler started (REPAIR-028 B)");
}

export function stopBackupScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

// Keep unused imports from breaking tree-shake in some bundlers
void writeFile;
void copyFile;
void existsSync;
void tmpdir;
