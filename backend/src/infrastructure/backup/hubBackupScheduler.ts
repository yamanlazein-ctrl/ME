import { existsSync, mkdirSync, readdirSync, renameSync, statSync } from "node:fs";
import { join } from "node:path";
import { logger } from "../config/logger.js";

/**
 * MIG-03 — the hub had no automatic backup at all (both schedulers start only on the desktop,
 * server.ts). This one runs on the hub when `HUB_BACKUP_DIR` is set: one portable v2 archive per
 * company every `HUB_BACKUP_INTERVAL_HOURS` (default 24), each written as `.partial`, VERIFIED with
 * the same full archive check a restore uses, and only then renamed to its final name.
 *
 * It never deletes a backup (owner rule): retention and the off-site copy are operator steps
 * (docs/HUB-MIGRATION-RUNBOOK.md). A failed archive is renamed `.failed`, never listed as a backup.
 */
export type HubBackupDeps = {
  listTenants: () => Promise<string[]>;
  /** Write a portable backup of one company to `outFile`. */
  createBackup: (tenantId: string, outFile: string) => Promise<void>;
  /** Full integrity check of an archive (throws on any problem). */
  verifyBackup: (file: string) => Promise<void>;
  now?: () => Date;
};

export type HubBackupResult = { tenantId: string; file: string; ok: boolean; error?: string };

const stamp = (d: Date) =>
  d.toISOString().replace(/[-:]/g, "").replace(/\..*$/, "").replace("T", "-");

/** One pass: back up every company, verify each archive, report per company. */
export async function runHubBackupOnce(
  dir: string,
  deps: HubBackupDeps,
): Promise<HubBackupResult[]> {
  mkdirSync(dir, { recursive: true });
  const at = stamp((deps.now ?? (() => new Date()))());
  const out: HubBackupResult[] = [];
  for (const tenantId of await deps.listTenants()) {
    const file = join(dir, `hub-backup-${tenantId}-${at}.zip`);
    const partial = `${file}.partial`;
    try {
      await deps.createBackup(tenantId, partial);
      await deps.verifyBackup(partial);
      renameSync(partial, file);
      out.push({ tenantId, file, ok: true });
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      if (existsSync(partial)) renameSync(partial, `${file}.failed`);
      logger.error({ err, tenantId }, "hub backup failed");
      out.push({ tenantId, file, ok: false, error });
    }
  }
  return out;
}

/** Age (ms) of the newest VERIFIED hub backup in `dir`, or null when there is none. */
export function newestHubBackupAgeMs(dir: string, now = Date.now()): number | null {
  if (!existsSync(dir)) return null;
  let newest = 0;
  for (const name of readdirSync(dir)) {
    if (!/^hub-backup-.+\.zip$/.test(name)) continue;
    newest = Math.max(newest, statSync(join(dir, name)).mtimeMs);
  }
  return newest ? now - newest : null;
}

let timer: ReturnType<typeof setInterval> | null = null;

/** Hub only (not the desktop): opt-in with HUB_BACKUP_DIR. */
export function startHubBackupScheduler(deps: HubBackupDeps): void {
  const dir = process.env.HUB_BACKUP_DIR?.trim();
  if (!dir || timer) return;
  const hours = Number(process.env.HUB_BACKUP_INTERVAL_HOURS ?? 24);
  const intervalMs = (Number.isFinite(hours) && hours > 0 ? hours : 24) * 3_600_000;
  const tick = async () => {
    const age = newestHubBackupAgeMs(dir);
    if (age !== null && age < intervalMs) return;
    const results = await runHubBackupOnce(dir, deps);
    const failed = results.filter((r) => !r.ok);
    if (failed.length) logger.error({ failed }, "hub backup: some companies were NOT backed up");
    else logger.info({ count: results.length, dir }, "hub backup verified");
  };
  void tick();
  timer = setInterval(() => void tick(), 60 * 60 * 1000);
  timer.unref?.();
  logger.info({ dir, hours }, "hub backup scheduler started (MIG-03)");
}
