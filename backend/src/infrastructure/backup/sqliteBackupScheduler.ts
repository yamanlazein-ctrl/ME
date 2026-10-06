/**
 * Desktop automatic backup policy on SQLite (specs/001-desktop-sqlite-engine T096/T099, OQ-5/OQ-6).
 *
 *   - Schedule: at startup when the newest VERIFIED automatic backup is older than 24 h (or there is
 *     none), then every 24 h while the app runs.
 *   - Retention: the 7 newest VERIFIED automatic backups in `<root>\backups`, plus a mirror copy
 *     (verified by sha256) in the user's Documents folder (backupMirrorRoot). Only VERIFIED automatic
 *     backups are pruned; manual and pre-operation backups are never deleted.
 *   - Weekly restore-test: once per 7 days the newest VERIFIED automatic backup is restored into a
 *     temp directory, migrated and compared (RS-5); the result is recorded in backups.json and only
 *     the temp directory is deleted.
 */
import { copyFileSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { logger } from "../config/logger.js";
import { backupMirrorRoot } from "./backupScheduler.js";
import { createAndVerifyBackup } from "./sqliteBackup.js";
import { removeBackupEntry, updateBackup, verifiedBackups, readRegistry } from "./backupRegistry.js";
import { restoreTest } from "./sqliteRestore.js";

export const KEEP_AUTOMATIC = 7;
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;

let timer: NodeJS.Timeout | null = null;
let running = false;

const sha256File = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");

/** Copy a VERIFIED backup to the mirror folder; kept only if its sha256 matches. */
export function mirrorVerifiedBackup(path: string, expectedSha256: string): string | null {
  const dir = backupMirrorRoot();
  if (!dir) return null;
  try {
    mkdirSync(dir, { recursive: true });
    const target = join(dir, basename(path));
    copyFileSync(path, `${target}.partial`);
    if (sha256File(`${target}.partial`) !== expectedSha256) {
      rmSync(`${target}.partial`, { force: true });
      throw new Error("mirror copy hash mismatch");
    }
    renameSync(`${target}.partial`, target);
    return target;
  } catch (err) {
    logger.warn({ err, dir }, "BACKUP_MIRROR_FAILED"); // never fails the primary backup
    return null;
  }
}

/** Keep the newest `keep` VERIFIED automatic backups (and their mirrors); prune nothing else. */
export function pruneAutomatic(keep = KEEP_AUTOMATIC): string[] {
  const pruned: string[] = [];
  for (const e of verifiedBackups("automatic").slice(keep)) {
    rmSync(e.path, { force: true });
    if (e.mirrorPath) rmSync(e.mirrorPath, { force: true });
    removeBackupEntry(e.path);
    pruned.push(e.path);
  }
  return pruned;
}

export async function runAutomaticBackupNow(): Promise<string | null> {
  if (running) return null;
  running = true;
  try {
    const created = await createAndVerifyBackup({ kind: "automatic" });
    const mirror = mirrorVerifiedBackup(created.path, created.sha256);
    updateBackup(created.path, { mirrorPath: mirror });
    const pruned = pruneAutomatic();
    logger.info({ path: created.path, mirror, pruned }, "AUTO_BACKUP_OK");
    return created.path;
  } catch (err) {
    logger.error({ err }, "AUTO_BACKUP_FAILED");
    return null;
  } finally {
    running = false;
  }
}

export function runWeeklyRestoreTestIfDue(now = Date.now()): { ran: boolean; ok?: boolean; detail?: string } {
  const autos = verifiedBackups("automatic");
  if (!autos.length) return { ran: false };
  const lastTest = readRegistry()
    .entries.map((e) => e.lastRestoreTest?.at)
    .filter((x): x is string => Boolean(x))
    .sort()
    .at(-1);
  if (lastTest && now - Date.parse(lastTest) < WEEK_MS) return { ran: false };
  const newest = autos[0];
  const temp = join(tmpdir(), `motard-restore-test-${randomUUID()}`);
  try {
    const r = restoreTest(newest.path, temp);
    updateBackup(newest.path, { lastRestoreTest: { at: new Date(now).toISOString(), ok: r.ok, detail: r.detail } });
    (r.ok ? logger.info : logger.error).call(logger, { path: newest.path, detail: r.detail }, r.ok ? "RESTORE_TEST_OK" : "RESTORE_TEST_FAILED");
    return { ran: true, ...r };
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

async function tick(): Promise<void> {
  const newest = verifiedBackups("automatic")[0];
  if (!newest || Date.now() - Date.parse(newest.createdAt) >= DAY_MS) await runAutomaticBackupNow();
  try {
    runWeeklyRestoreTestIfDue();
  } catch (err) {
    logger.error({ err }, "RESTORE_TEST_ERROR");
  }
}

export function startSqliteBackupScheduler(): void {
  if (timer) return;
  void tick();
  timer = setInterval(() => void tick(), 60 * 60 * 1000); // hourly check; backups stay 24 h apart
  timer.unref?.();
}

export function stopSqliteBackupScheduler(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

