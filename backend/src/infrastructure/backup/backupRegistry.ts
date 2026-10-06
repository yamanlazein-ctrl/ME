/**
 * Backup registry `<root>\backups.json` (specs/001-desktop-sqlite-engine T094, data-model.md §5.2).
 *
 * One entry per backup file: path, kind, created, status, sizes and hashes, last restore-test.
 * Status follows CREATING → … → VERIFIED | FAILED; only VERIFIED entries count for the UI, for
 * retention and for the integrity manifest's `lastSuccessfulBackupAt`. Written atomically
 * (temp + rename) so a crash never leaves a half-written registry.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { getSqliteRuntime } from "../orm/sqlite/runtime.js";
import { logger } from "../config/logger.js";

export type BackupKind = "manual" | "automatic" | "pre-operation" | "pre-migration" | "pre-restore" | "pre-update";
export type BackupStatus = "CREATING" | "VERIFIED" | "FAILED";

export interface RestoreTestResult {
  at: string;
  ok: boolean;
  detail: string;
}

export interface BackupEntry {
  path: string;
  kind: BackupKind;
  createdAt: string;
  status: BackupStatus;
  sizeBytes?: number;
  sha256?: string;
  manifestSha256?: string;
  error?: string;
  mirrorPath?: string | null;
  lastRestoreTest?: RestoreTestResult;
}

interface RegistryFile {
  version: 1;
  entries: BackupEntry[];
}

/** `<root>\backups.json`; root = parent of the `data\` directory holding motard.db. */
export function registryPath(root?: string): string {
  const override = process.env.MOTARD_BACKUP_REGISTRY;
  if (override) return override;
  if (root) return join(root, "backups.json");
  const rt = getSqliteRuntime();
  if (!rt) throw new Error("SQLITE_NOT_INITIALIZED");
  return join(dirname(dirname(rt.conns.path)), "backups.json");
}

export function readRegistry(root?: string): RegistryFile {
  const p = registryPath(root);
  if (!existsSync(p)) return { version: 1, entries: [] };
  try {
    const parsed = JSON.parse(readFileSync(p, "utf8")) as RegistryFile;
    return { version: 1, entries: Array.isArray(parsed.entries) ? parsed.entries : [] };
  } catch (err) {
    // An unreadable registry never hides backups silently: it is kept aside and rebuilt.
    logger.error({ err, p }, "BACKUP_REGISTRY_UNREADABLE — keeping the file aside and starting a new registry");
    renameSync(p, `${p}.unreadable-${Date.now()}`);
    return { version: 1, entries: [] };
  }
}

function writeRegistry(reg: RegistryFile, root?: string): void {
  const p = registryPath(root);
  mkdirSync(dirname(p), { recursive: true });
  const tmp = `${p}.tmp`;
  writeFileSync(tmp, JSON.stringify(reg, null, 2));
  renameSync(tmp, p);
}

const same = (a: string, b: string) => resolve(a).toLowerCase() === resolve(b).toLowerCase();

export function recordBackup(e: Omit<BackupEntry, "createdAt"> & { createdAt?: string }, root?: string): BackupEntry {
  const reg = readRegistry(root);
  const existing = reg.entries.find((x) => same(x.path, e.path));
  const entry: BackupEntry = { ...existing, ...e, createdAt: e.createdAt ?? existing?.createdAt ?? new Date().toISOString() } as BackupEntry;
  reg.entries = [...reg.entries.filter((x) => !same(x.path, e.path)), entry];
  writeRegistry(reg, root);
  if (entry.status === "VERIFIED") void markLastSuccessfulBackup(entry.createdAt);
  return entry;
}

export function updateBackup(path: string, patch: Partial<BackupEntry>): void {
  const reg = readRegistry();
  reg.entries = reg.entries.map((x) => (same(x.path, path) ? { ...x, ...patch } : x));
  writeRegistry(reg);
}

export function removeBackupEntry(path: string): void {
  const reg = readRegistry();
  reg.entries = reg.entries.filter((x) => !same(x.path, path));
  writeRegistry(reg);
}

/** VERIFIED entries whose file still exists, newest first. */
export function verifiedBackups(kind?: BackupKind): BackupEntry[] {
  return readRegistry()
    .entries.filter((e) => e.status === "VERIFIED" && (!kind || e.kind === kind) && existsSync(e.path))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
}

async function markLastSuccessfulBackup(at: string): Promise<void> {
  try {
    const { readManifest, writeManifestAtomic } = await import("../integrity/dataIntegrityManifest.js");
    const m = await readManifest();
    if (m && (!m.lastSuccessfulBackupAt || m.lastSuccessfulBackupAt < at)) {
      await writeManifestAtomic({ ...m, lastSuccessfulBackupAt: at });
    }
  } catch (err) {
    logger.warn({ err }, "could not stamp lastSuccessfulBackupAt");
  }
}
