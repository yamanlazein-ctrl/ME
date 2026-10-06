/**
 * Desktop SQLite boot (specs/001-desktop-sqlite-engine T045; contracts/data-root-and-startup-states.md,
 * data-model.md §3, constitution Principle IV).
 *
 * One entry point, `bootSqlite`, run before the server listens:
 *   - FRESH (decided by the runtime): build the database under a temporary name, apply the
 *     migrations and mint `motard_meta` in one transaction, then rename it into place — a crash
 *     never leaves a half-built file at SQLITE_PATH. FRESH refuses to touch an existing file.
 *   - otherwise: open the EXISTING file only (never created implicitly), refuse a foreign
 *     `data_id` or a schema newer than this binary, snapshot then apply pending migrations
 *     forward only, and verify the live schema against the committed fingerprint.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { openSqlite, closeSqlite, type SqliteConnections } from "./connection.js";
import { initSqliteTransactions, resetSqliteTransactionsForTests } from "./transaction.js";
import { createAndVerifyBackupSync } from "../../backup/sqliteBackup.js";
import { formatMicrosUtc, nextMonotonicMicros } from "./clock.js";
import {
  readSqliteFingerprint,
  diffSqliteFingerprint,
  loadSqliteJournal,
  loadCommittedSqliteFingerprint,
} from "./schemaFingerprint.js";

export class SqliteBootError extends Error {
  constructor(
    readonly code:
      | "FRESH_TARGET_EXISTS"
      | "DATABASE_MISSING"
      | "META_MISSING"
      | "DATA_ID_MISMATCH"
      | "SCHEMA_TOO_NEW"
      | "SCHEMA_UNVERIFIED"
      | "INSTALLATION_ID_REQUIRED"
      | "INSTALL_INSTANCE_MISMATCH"
      | "INTEGRITY_FAILED",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "SqliteBootError";
  }
}

export interface SqliteBootOptions {
  path: string;
  migrationsDir: string;
  startupState?: "FRESH" | "REUSE" | "OPEN_EXISTING";
  expectedDataId?: string;
  installationId?: string;
  installInstanceId?: string;
  appVersion?: string;
  /** Where pre-migration snapshots go (default: `<data dir>/../snapshots`). */
  snapshotDir?: string;
  /** Desktop deploys must name the installation that creates a file. */
  requireInstallationId?: boolean;
  /**
   * FRESH only: the build-time desktop seed (resources/server/desktop-seed.json, T077) — the default
   * tenant and the pre-signed licence the PostgreSQL template shipped, inserted verbatim.
   */
  seedPath?: string;
  /**
   * Desktop REUSE (T076, D-1): the runtime passes the HKCU install-instance marker (possibly empty)
   * and asks for the check. A database recorded for another installation instance — or recorded
   * for one while this installation has no marker — is a NEW installation: never reused silently.
   */
  checkInstallInstance?: boolean;
  /**
   * US3 (T084/T085): the runtime decided this database belongs to this installation although the
   * install instance changed — REUSE after an application update (valid hand-off token) or the
   * user's explicit "Open existing data". Record the new instance (and this device's installation
   * id in adopted_installation_ids) instead of refusing.
   */
  adoptInstallInstance?: boolean;
}

interface DesktopSeed {
  format: "motard-desktop-seed";
  version: number;
  tenant: Record<string, unknown>;
  license: Record<string, unknown>;
}

function insertRow(db: Database.Database, table: string, row: Record<string, unknown>): void {
  const cols = Object.keys(row);
  db.prepare(`INSERT INTO "${table}" (${cols.map((c) => `"${c}"`).join(", ")}) VALUES (${cols.map(() => "?").join(", ")})`).run(
    ...cols.map((c) => row[c]),
  );
}

export interface MotardMetaRow {
  data_id: string;
  created_by_installation_id: string;
  adopted_installation_ids: string;
  install_instance_id: string | null;
  tenant_id: string | null;
  schema_journal_idx: number;
  app_version_last_opened: string | null;
}

export interface SqliteBootResult {
  conns: SqliteConnections;
  meta: MotardMetaRow;
  created: boolean;
  appliedMigrations: string[];
  snapshotPath: string | null;
}

/** The migrations folder: env override (bundled desktop) or the source tree. */
export function resolveSqliteMigrationsFolder(
  envFolder = process.env.DESKTOP_SQLITE_MIGRATIONS_FOLDER,
  cwd = process.cwd(),
): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    envFolder,
    join(cwd, "src", "infrastructure", "orm", "sqlite", "migrations"),
    join(here, "sqlite-migrations"), // desktop bundle: next to server.mjs
    join(here, "migrations"), // source tree: next to this module
  ].filter((c): c is string => Boolean(c));
  for (const c of candidates) {
    const journal = join(c, "meta", "_journal.json");
    // Only a SQLite journal qualifies: the bundle also ships the PG migrations as `migrations/`.
    if (existsSync(journal) && (JSON.parse(readFileSync(journal, "utf8")) as { dialect?: string }).dialect === "sqlite") return c;
  }
  throw new Error(`SQLite migrations folder not found (tried: ${candidates.join(", ")})`);
}

function applyMigration(db: Database.Database, migrationsDir: string, tag: string): void {
  db.exec(readFileSync(join(migrationsDir, `${tag}.sql`), "utf8"));
}

function createFresh(opts: SqliteBootOptions, lastIdx: number, journal: ReturnType<typeof loadSqliteJournal>): void {
  if (existsSync(opts.path)) {
    throw new SqliteBootError("FRESH_TARGET_EXISTS", `refusing to create over an existing database at ${opts.path}`);
  }
  if (opts.requireInstallationId && !opts.installationId) {
    throw new SqliteBootError("INSTALLATION_ID_REQUIRED", "MOTARD_INSTALLATION_ID is required to create the database");
  }
  mkdirSync(dirname(opts.path), { recursive: true });
  const temp = `${opts.path}.creating`;
  for (const f of [temp, `${temp}-wal`, `${temp}-shm`]) rmSync(f, { force: true }); // stale, never held committed data
  const db = new Database(temp);
  try {
    db.pragma("journal_mode = WAL");
    db.pragma("synchronous = FULL");
    db.pragma("foreign_keys = ON");
    db.pragma("trusted_schema = OFF");
    db.exec("BEGIN IMMEDIATE");
    for (const e of journal.entries) applyMigration(db, opts.migrationsDir, e.tag);
    let seededTenant: string | null = null;
    if (opts.seedPath) {
      const seed = JSON.parse(readFileSync(opts.seedPath, "utf8")) as DesktopSeed;
      if (seed.format !== "motard-desktop-seed") throw new Error(`${opts.seedPath} is not a desktop seed`);
      insertRow(db, "tenants", seed.tenant);
      insertRow(db, "licenses", seed.license);
      seededTenant = String(seed.tenant.id);
    }
    db.prepare(
      `INSERT INTO motard_meta (id, data_id, created_by_installation_id, install_instance_id, tenant_id, schema_journal_idx, app_version_last_opened, created_at)
       VALUES (1, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      opts.expectedDataId ?? randomUUID(),
      opts.installationId ?? "unbound",
      opts.installInstanceId ?? null,
      seededTenant,
      lastIdx,
      opts.appVersion ?? null,
      formatMicrosUtc(nextMonotonicMicros()),
    );
    db.exec("COMMIT");
    db.pragma("wal_checkpoint(TRUNCATE)");
  } catch (e) {
    if (db.inTransaction) db.exec("ROLLBACK");
    db.close();
    for (const f of [temp, `${temp}-wal`, `${temp}-shm`]) rmSync(f, { force: true });
    throw e;
  }
  db.close();
  renameSync(temp, opts.path); // atomic on the same volume
}

export function bootSqlite(opts: SqliteBootOptions): SqliteBootResult {
  const journal = loadSqliteJournal(opts.migrationsDir);
  const lastIdx = journal.entries.at(-1)!.idx;
  let created = false;
  if (opts.startupState === "FRESH") {
    createFresh(opts, lastIdx, journal);
    created = true;
  } else if (!existsSync(opts.path)) {
    throw new SqliteBootError("DATABASE_MISSING", `no database at ${opts.path} and the runtime did not pass FRESH`);
  }

  const conns = openSqlite(opts.path);
  try {
    const meta = conns.writer.prepare("SELECT * FROM motard_meta WHERE id = 1").get() as MotardMetaRow | undefined;
    if (!meta) throw new SqliteBootError("META_MISSING", `${opts.path} has no motard_meta row`);
    if (opts.expectedDataId && meta.data_id !== opts.expectedDataId) {
      throw new SqliteBootError("DATA_ID_MISMATCH", `database data_id ${meta.data_id} ≠ expected ${opts.expectedDataId}`);
    }
    if (meta.schema_journal_idx > lastIdx) {
      throw new SqliteBootError("SCHEMA_TOO_NEW", `database schema ${meta.schema_journal_idx} is newer than this app (${lastIdx})`);
    }
    if (!created && opts.adoptInstallInstance) {
      const adopted = new Set<string>(JSON.parse(String(meta.adopted_installation_ids ?? "[]")) as string[]);
      if (opts.installationId && opts.installationId !== meta.created_by_installation_id) adopted.add(opts.installationId);
      conns.writer
        .prepare("UPDATE motard_meta SET install_instance_id = ?, adopted_installation_ids = ? WHERE id = 1")
        .run(opts.installInstanceId?.trim() || null, JSON.stringify([...adopted]));
    } else if (!created && opts.checkInstallInstance) {
      const marker = opts.installInstanceId?.trim() || null;
      const recorded = (meta.install_instance_id as string | null)?.trim() || null;
      if (marker !== recorded) {
        throw new SqliteBootError(
          "INSTALL_INSTANCE_MISMATCH",
          `new installation detected (marker ${marker ?? "absent"}, database recorded ${recorded ?? "none"}): not reused`,
        );
      }
    }
    if (!created && opts.startupState === "REUSE") {
      const check = conns.writer.pragma("integrity_check", { simple: true });
      if (check !== "ok") throw new SqliteBootError("INTEGRITY_FAILED", `integrity_check: ${String(check)}`);
    }

    const pending = journal.entries.filter((e) => e.idx > meta.schema_journal_idx);
    let snapshotPath: string | null = null;
    if (pending.length) {
      // T074/T095: a VERIFIED v3 backup (kind pre-migration) before any schema change; if it cannot
      // be made and verified, the migration is refused and the database is left untouched.
      snapshotPath = createAndVerifyBackupSync(conns.writer, opts.path, {
        kind: "pre-migration",
        dir: opts.snapshotDir,
        fileName: `pre-migration-${meta.schema_journal_idx}-to-${pending.at(-1)!.idx}-${Date.now()}.zip`,
        appVersion: opts.appVersion,
      }).path;
      for (const e of pending) {
        conns.writer.exec("BEGIN IMMEDIATE");
        try {
          applyMigration(conns.writer, opts.migrationsDir, e.tag);
          conns.writer.prepare("UPDATE motard_meta SET schema_journal_idx = ? WHERE id = 1").run(e.idx);
          conns.writer.exec("COMMIT");
        } catch (err) {
          if (conns.writer.inTransaction) conns.writer.exec("ROLLBACK");
          throw err;
        }
      }
    }

    const diff = diffSqliteFingerprint(
      loadCommittedSqliteFingerprint(opts.migrationsDir),
      readSqliteFingerprint(conns.writer, lastIdx),
    );
    if (diff.length) {
      throw new SqliteBootError("SCHEMA_UNVERIFIED", `live schema differs from the committed fingerprint: ${diff.slice(0, 20).join("; ")}`);
    }

    if (opts.appVersion && meta.app_version_last_opened !== opts.appVersion) {
      conns.writer.prepare("UPDATE motard_meta SET app_version_last_opened = ? WHERE id = 1").run(opts.appVersion);
    }
    initSqliteTransactions(conns);
    const finalMeta = conns.writer.prepare("SELECT * FROM motard_meta WHERE id = 1").get() as MotardMetaRow;
    return { conns, meta: finalMeta, created, appliedMigrations: pending.map((e) => e.tag), snapshotPath };
  } catch (e) {
    closeSqlite(conns);
    throw e;
  }
}

// ─── process-wide runtime ──────────────────────────────────────────────────

let booted: SqliteBootResult | null = null;
let lastBootOptions: SqliteBootOptions | null = null;

/** Boot once from the process configuration (desktop server start, or the first SQLite use). */
export async function ensureSqliteRuntime(): Promise<SqliteBootResult> {
  if (booted) return booted;
  const { config } = await import("../../config/env.js");
  if (!config.SQLITE_PATH) throw new Error("SQLITE_PATH is required when DB_ENGINE=sqlite");
  lastBootOptions = {
    path: config.SQLITE_PATH,
    migrationsDir: resolveSqliteMigrationsFolder(),
    startupState: config.MOTARD_STARTUP_STATE,
    expectedDataId: config.MOTARD_DATA_ID,
    installationId: config.MOTARD_INSTALLATION_ID,
    installInstanceId: config.MOTARD_INSTALL_INSTANCE_ID,
    appVersion: process.env.MOTARD_APP_VERSION,
    requireInstallationId: config.DESKTOP_DEPLOY,
    seedPath: process.env.DESKTOP_SEED_PATH || undefined,
    checkInstallInstance: process.env.MOTARD_INSTALL_INSTANCE_CHECK === "1",
    adoptInstallInstance: process.env.MOTARD_ADOPT_INSTALL_INSTANCE === "1",
  };
  booted = bootSqlite(lastBootOptions);
  return booted;
}

/**
 * The migrations this running binary booted with. Anything that migrates a copy for this runtime
 * (restore staging) must use the same set, or REOPEN would see a schema the app does not know.
 */
export function sqliteRuntimeMigrationsDir(): string {
  return lastBootOptions?.migrationsDir ?? resolveSqliteMigrationsFolder();
}

export function getSqliteRuntime(): SqliteBootResult | null {
  return booted;
}

/** Graceful shutdown (WAL checkpoint + close). */
export function shutdownSqliteRuntime(): void {
  if (!booted) return;
  closeSqlite(booted.conns);
  booted = null;
  resetSqliteTransactionsForTests();
}

/**
 * Apply this binary's pending migrations to a standalone database file (restore staging), forward
 * only, then verify the committed fingerprint. The live database is never touched.
 */
export function migrateFileForward(path: string, migrationsDir: string): { applied: string[]; fromIdx: number; toIdx: number } {
  const journal = loadSqliteJournal(migrationsDir);
  const lastIdx = journal.entries.at(-1)!.idx;
  const db = new Database(path, { fileMustExist: true });
  try {
    db.pragma("foreign_keys = ON");
    db.pragma("trusted_schema = OFF");
    const meta = db.prepare("SELECT schema_journal_idx FROM motard_meta WHERE id = 1").get() as { schema_journal_idx: number } | undefined;
    if (!meta) throw new SqliteBootError("META_MISSING", `${path} has no motard_meta row`);
    if (meta.schema_journal_idx > lastIdx) {
      throw new SqliteBootError("SCHEMA_TOO_NEW", `backup schema ${meta.schema_journal_idx} is newer than this app (${lastIdx})`);
    }
    const pending = journal.entries.filter((e) => e.idx > meta.schema_journal_idx);
    for (const e of pending) {
      db.exec("BEGIN IMMEDIATE");
      try {
        applyMigration(db, migrationsDir, e.tag);
        db.prepare("UPDATE motard_meta SET schema_journal_idx = ? WHERE id = 1").run(e.idx);
        db.exec("COMMIT");
      } catch (err) {
        if (db.inTransaction) db.exec("ROLLBACK");
        throw err;
      }
    }
    const diff = diffSqliteFingerprint(loadCommittedSqliteFingerprint(migrationsDir), readSqliteFingerprint(db, lastIdx));
    if (diff.length) throw new SqliteBootError("SCHEMA_UNVERIFIED", `staging schema differs from the committed fingerprint: ${diff.slice(0, 20).join("; ")}`);
    return { applied: pending.map((e) => e.tag), fromIdx: meta.schema_journal_idx, toIdx: lastIdx };
  } finally {
    db.close();
  }
}

/**
 * Close the live runtime and boot again from the same path (after a restore swap), with the
 * identity now expected for that file. Callers hold the write gate.
 */
export function reopenSqliteRuntime(overrides: Partial<SqliteBootOptions> = {}): SqliteBootResult {
  if (!booted) throw new Error("SQLITE_NOT_INITIALIZED");
  const previous = booted;
  closeSqlite(previous.conns);
  resetSqliteTransactionsForTests();
  booted = bootSqlite({ ...lastBootOptions!, ...overrides, startupState: "OPEN_EXISTING" });
  return booted;
}
