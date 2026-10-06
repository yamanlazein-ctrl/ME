/**
 * Desktop restore of a v3 backup (specs/001-desktop-sqlite-engine T098, data-model.md §5.3,
 * contracts/backup-format-v3.md §Restore guarantees).
 *
 *   VERIFY_ARCHIVE → SAFETY_BACKUP(VERIFIED) → EXTRACT_STAGING → MIGRATE_STAGING → VERIFY_STAGING (RS-5)
 *   → CARRY_OVER_DEVICE_STATE → SWAP (old file kept in set-aside\) → REOPEN
 *
 * The archive is only ever read. Until SWAP the live database is not touched at all, so a failure
 * at any earlier step leaves it byte-identical. A failure while reopening puts the previous file back.
 */
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { logger } from "../config/logger.js";
import { ensureSqliteRuntime, migrateFileForward, reopenSqliteRuntime, sqliteRuntimeMigrationsDir } from "../orm/sqlite/runtime.js";
import { withWriteGateHeld } from "../orm/sqlite/transaction.js";
import { loadSqliteJournal } from "../orm/sqlite/schemaFingerprint.js";
import { createAndVerifyBackup, openAndVerifyBackupV3Sync, EXCLUDED_TABLES, NULLED_COLUMNS, BackupV3Error, type BackupManifestV3 } from "./sqliteBackup.js";
import { rs5Figures, rs5Diff } from "./rs5.js";

export type RestoreStep =
  | "VERIFY_ARCHIVE"
  | "SAFETY_BACKUP"
  | "EXTRACT_STAGING"
  | "MIGRATE_STAGING"
  | "VERIFY_STAGING"
  | "CARRY_OVER_DEVICE_STATE"
  | "SWAP"
  | "REOPEN";

export class RestoreError extends Error {
  constructor(
    readonly step: RestoreStep,
    message: string,
    readonly cause?: unknown,
  ) {
    super(`RESTORE_FAILED at ${step}: ${message}`);
    this.name = "RestoreError";
  }
}

export interface RestoreReport {
  manifest: BackupManifestV3;
  safetyBackup: string;
  setAside: string;
  migrated: string[];
  carriedOver: Record<string, number>;
  dataId: string;
}

/** Test hook: throw at a given step (T091 forced-failure checks). */
export interface RestoreOptions {
  failAt?: RestoreStep;
  /** Skip the safety backup (only for the weekly restore-test, which never swaps). */
  skipSafetyBackup?: boolean;
}

const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

/**
 * Copy the live device-bound state into the staging copy (same-device restore keeps its activation,
 * binding, secrets and activation log). Rows that would not be consistent with the restored company
 * (another licence/tenant) are dropped, so a new-device restore ends with none — licence verification
 * is then required on that device.
 */
function carryOverDeviceState(stagingPath: string, livePath: string): Record<string, number> {
  const db = new Database(stagingPath);
  const carried: Record<string, number> = {};
  try {
    db.pragma("foreign_keys = OFF");
    db.prepare("ATTACH DATABASE ? AS live").run(livePath);
    const triggers = db
      .prepare("SELECT name, sql FROM main.sqlite_schema WHERE type = 'trigger' AND tbl_name = 'license_audit_events'")
      .all() as Array<{ name: string; sql: string }>;
    db.exec("BEGIN");
    for (const t of triggers) db.exec(`DROP TRIGGER main."${t.name}"`);
    for (const table of EXCLUDED_TABLES) {
      const cols = (db.prepare(`SELECT name FROM pragma_table_info(?)`).pluck().all(table) as string[]).map((c) => `"${c}"`).join(", ");
      db.exec(`INSERT INTO main."${table}" (${cols}) SELECT ${cols} FROM live."${table}"`);
    }
    // nulled device-bound columns: copied back where the same row (same id) exists in both
    db.exec(`UPDATE main.licenses SET
        binding_type = (SELECT l.binding_type FROM live.licenses l WHERE l.id = main.licenses.id),
        binding_value = (SELECT l.binding_value FROM live.licenses l WHERE l.id = main.licenses.id),
        offline_token = (SELECT l.offline_token FROM live.licenses l WHERE l.id = main.licenses.id),
        offline_token_jti = (SELECT l.offline_token_jti FROM live.licenses l WHERE l.id = main.licenses.id)
      WHERE id IN (SELECT id FROM live.licenses)`);
    db.exec(`UPDATE main.tenants SET activation_id = (SELECT t.activation_id FROM live.tenants t WHERE t.id = main.tenants.id)
      WHERE id IN (SELECT id FROM live.tenants)`);
    db.exec(`UPDATE main.sync_devices SET device_registration_id = (SELECT d.device_registration_id FROM live.sync_devices d WHERE d.id = main.sync_devices.id)
      WHERE id IN (SELECT id FROM live.sync_devices)`);
    // drop whatever does not fit the restored company: repeat until no FK violation remains
    for (let round = 0; round < 20; round++) {
      const bad = db.pragma("foreign_key_check") as Array<{ table: string; rowid: number; parent: string; fkid: number }>;
      if (!bad.length) break;
      for (const v of bad) {
        if ((EXCLUDED_TABLES as readonly string[]).includes(v.table)) {
          db.prepare(`DELETE FROM main."${v.table}" WHERE rowid = ?`).run(v.rowid);
        } else if (v.table in NULLED_COLUMNS) {
          const fk = db.prepare(`SELECT "from" FROM pragma_foreign_key_list(?) WHERE id = ?`).pluck().all(v.table, v.fkid) as string[];
          const nullable = fk.filter((c) => NULLED_COLUMNS[v.table].includes(c));
          if (!nullable.length) throw new Error(`carry-over left an FK violation in ${v.table}`);
          db.prepare(`UPDATE main."${v.table}" SET ${nullable.map((c) => `"${c}" = NULL`).join(", ")} WHERE rowid = ?`).run(v.rowid);
        } else {
          throw new Error(`carry-over left an FK violation in ${v.table}`);
        }
      }
    }
    for (const t of triggers) db.exec(t.sql);
    db.exec("COMMIT");
    for (const table of EXCLUDED_TABLES) carried[table] = db.prepare(`SELECT count(*) FROM main."${table}"`).pluck().get() as number;
    db.exec("DETACH DATABASE live");
    db.pragma("foreign_keys = ON");
    const fk = db.pragma("foreign_key_check") as unknown[];
    if (fk.length) throw new Error(`staging has ${fk.length} FK violation(s) after carry-over`);
    if (db.pragma("integrity_check", { simple: true }) !== "ok") throw new Error("staging integrity_check failed after carry-over");
    db.pragma("journal_mode = WAL");
    return carried;
  } catch (e) {
    if (db.inTransaction) db.exec("ROLLBACK");
    throw e;
  } finally {
    db.close();
  }
}

/**
 * T109 (OQ-12, SY-6/SY-7; owner decision 2026-10-05, option b): a restored database that had
 * synchronized with a hub resumes sync PAUSED, under a NEW sync identity to be registered on the
 * hub (see ISyncRestoreStateStore). Written into the staging copy, so it lands with the same
 * atomic swap as the data. A database that never synchronized is left alone.
 */
function markRestoredSyncSnapshot(staging: Database.Database, live: Database.Database): void {
  const one = (db: Database.Database, q: string) => db.prepare(q).pluck().get() as number | string | null | undefined;
  const synced =
    Number(one(staging, "SELECT count(*) FROM sync_state WHERE last_pull_seq IS NOT NULL")) > 0 ||
    Number(one(staging, "SELECT count(*) FROM sync_outbox WHERE status = 'synced'")) > 0 ||
    Number(one(staging, "SELECT count(*) FROM sync_inbox")) > 0;
  if (!synced) return;
  const previous = new Set(
    (staging.prepare("SELECT DISTINCT sync_device_id FROM sync_outbox WHERE sync_device_id IS NOT NULL").pluck().all() as string[]),
  );
  let generation = 0;
  for (const db of [staging, live]) {
    const row = db.prepare("SELECT generation, new_device_id FROM motard_sync_restore WHERE id = 1").get() as
      | { generation: number; new_device_id: string | null }
      | undefined;
    if (!row) continue;
    generation = Math.max(generation, Number(row.generation));
    if (row.new_device_id) previous.add(row.new_device_id);
  }
  const now = new Date().toISOString().replace("Z", "000Z");
  staging
    .prepare(
      `INSERT OR REPLACE INTO motard_sync_restore
         (id, restored_at, generation, previous_device_ids, new_device_id, phase, pulled, acknowledged, last_error, updated_at)
       VALUES (1, ?, ?, ?, NULL, 'register', 0, 0, NULL, ?)`,
    )
    .run(now, generation + 1, JSON.stringify([...previous]), now);
}

export async function restoreBackupV3(file: string, opts: RestoreOptions = {}): Promise<RestoreReport> {
  const step = (s: RestoreStep) => {
    if (opts.failAt === s) throw new RestoreError(s, "forced failure (test)");
  };
  const rt = await ensureSqliteRuntime();
  const livePath = rt.conns.path;
  const root = dirname(dirname(livePath));
  const migrationsDir = sqliteRuntimeMigrationsDir();
  const maxIdx = loadSqliteJournal(migrationsDir).entries.at(-1)!.idx;
  const staging = `${livePath}.restore-staging`;
  for (const f of [staging, `${staging}-wal`, `${staging}-shm`]) rmSync(f, { force: true });

  // VERIFY_ARCHIVE — read-only
  let opened;
  try {
    step("VERIFY_ARCHIVE");
    opened = openAndVerifyBackupV3Sync(file, { keep: true, maxJournalIdx: maxIdx });
  } catch (e) {
    if (e instanceof RestoreError) throw e;
    throw new RestoreError("VERIFY_ARCHIVE", e instanceof Error ? e.message : String(e), e);
  }
  try {
    // SAFETY_BACKUP — a VERIFIED copy of the current state before anything else
    let safety = "";
    if (!opts.skipSafetyBackup) {
      try {
        step("SAFETY_BACKUP");
        safety = (await createAndVerifyBackup({ kind: "pre-restore" })).path;
      } catch (e) {
        if (e instanceof RestoreError) throw e;
        throw new RestoreError("SAFETY_BACKUP", e instanceof Error ? e.message : String(e), e);
      }
    }
    // EXTRACT_STAGING — same volume as the live file (atomic rename later)
    const expected = rs5Figures(opened.databasePath);
    try {
      step("EXTRACT_STAGING");
      copyFileSync(opened.databasePath, staging);
    } catch (e) {
      if (e instanceof RestoreError) throw e;
      throw new RestoreError("EXTRACT_STAGING", e instanceof Error ? e.message : String(e), e);
    }
    // MIGRATE_STAGING — forward only, staging only
    let migrated: string[] = [];
    try {
      step("MIGRATE_STAGING");
      migrated = migrateFileForward(staging, migrationsDir).applied;
    } catch (e) {
      if (e instanceof RestoreError) throw e;
      throw new RestoreError("MIGRATE_STAGING", e instanceof Error ? e.message : String(e), e);
    }
    // VERIFY_STAGING (RS-5)
    try {
      step("VERIFY_STAGING");
      const diff = rs5Diff(expected, rs5Figures(staging));
      if (diff.length) throw new Error(`RS-5 comparison failed: ${diff.slice(0, 10).join("; ")}`);
    } catch (e) {
      if (e instanceof RestoreError) throw e;
      throw new RestoreError("VERIFY_STAGING", e instanceof Error ? e.message : String(e), e);
    }
    // CARRY_OVER_DEVICE_STATE
    let carriedOver: Record<string, number>;
    try {
      step("CARRY_OVER_DEVICE_STATE");
      carriedOver = carryOverDeviceState(staging, livePath);
    } catch (e) {
      if (e instanceof RestoreError) throw e;
      throw new RestoreError("CARRY_OVER_DEVICE_STATE", e instanceof Error ? e.message : String(e), e);
    }
    // identity of the restored file + provenance (SY-6)
    const dataId = opened.manifest.data.dataId;
    {
      const db = new Database(staging);
      try {
        const installation = process.env.MOTARD_INSTALLATION_ID ?? null;
        const meta = db.prepare("SELECT adopted_installation_ids FROM motard_meta WHERE id = 1").get() as { adopted_installation_ids: string };
        const adopted = new Set<string>(JSON.parse(meta.adopted_installation_ids) as string[]);
        if (installation) adopted.add(installation);
        db.prepare("UPDATE motard_meta SET restored_from = ?, adopted_installation_ids = ?, install_instance_id = ? WHERE id = 1").run(
          JSON.stringify({ dataId, manifestSha256: sha256(readFileSync(file)) }),
          JSON.stringify([...adopted]),
          process.env.MOTARD_INSTALL_INSTANCE_ID ?? null,
        );
        markRestoredSyncSnapshot(db, rt.conns.writer);
      } finally {
        db.close();
      }
    }
    // SWAP + REOPEN, holding the write gate (no transaction can be in flight)
    const setAsideDir = join(root, "set-aside", new Date().toISOString().replace(/[:.]/g, "-"));
    await withWriteGateHeld(async () => {
      step("SWAP");
      const { closeSqlite } = await import("../orm/sqlite/connection.js");
      closeSqlite(rt.conns); // checkpoint + close: the live file is complete on its own
      mkdirSync(setAsideDir, { recursive: true });
      const moved: string[] = [];
      try {
        for (const suffix of ["", "-wal", "-shm"]) {
          if (existsSync(`${livePath}${suffix}`)) {
            renameSync(`${livePath}${suffix}`, join(setAsideDir, `motard.db${suffix}`));
            moved.push(suffix);
          }
        }
        renameSync(staging, livePath);
      } catch (e) {
        for (const suffix of moved) renameSync(join(setAsideDir, `motard.db${suffix}`), `${livePath}${suffix}`);
        reopenSqliteRuntime();
        throw new RestoreError("SWAP", e instanceof Error ? e.message : String(e), e);
      }
      try {
        step("REOPEN");
        reopenSqliteRuntime({ expectedDataId: dataId });
        process.env.MOTARD_DATA_ID = dataId;
      } catch (e) {
        // put the previous database back exactly as it was
        rmSync(livePath, { force: true });
        for (const suffix of ["", "-wal", "-shm"]) {
          if (existsSync(join(setAsideDir, `motard.db${suffix}`))) renameSync(join(setAsideDir, `motard.db${suffix}`), `${livePath}${suffix}`);
        }
        reopenSqliteRuntime();
        throw e instanceof RestoreError ? e : new RestoreError("REOPEN", e instanceof Error ? e.message : String(e), e);
      }
    });
    // mirror the new identity for the runtime's next start
    const metaPath = process.env.DESKTOP_DB_META_PATH;
    if (metaPath && existsSync(metaPath)) {
      try {
        const m = JSON.parse(readFileSync(metaPath, "utf8")) as Record<string, unknown>;
        m.data_id = dataId;
        m.tenant_id = opened.manifest.tenant.id;
        writeFileSync(metaPath, `${JSON.stringify(m, null, 2)}\n`);
      } catch (err) {
        logger.warn({ err, metaPath }, "could not update db-meta.json after restore");
      }
    }
    (await import("../sync/restoredIdentity.js")).invalidateRestoredIdentity();
    logger.info({ file, migrated, carriedOver, setAsideDir }, "RESTORE_OK");
    return { manifest: opened.manifest, safetyBackup: safety, setAside: setAsideDir, migrated, carriedOver, dataId };
  } finally {
    rmSync(opened.workDir, { recursive: true, force: true });
    for (const f of [staging, `${staging}-wal`, `${staging}-shm`]) if (existsSync(f)) rmSync(f, { force: true });
  }
}

/**
 * Weekly restore-test (T099, OQ-6): restore a VERIFIED backup into a temp directory, migrate it and
 * run RS-5 — never touching the live database. Returns ok/detail for the registry.
 */
export function restoreTest(file: string, tempDir: string): { ok: boolean; detail: string } {
  const migrationsDir = sqliteRuntimeMigrationsDir();
  const maxIdx = loadSqliteJournal(migrationsDir).entries.at(-1)!.idx;
  let opened;
  try {
    opened = openAndVerifyBackupV3Sync(file, { keep: true, maxJournalIdx: maxIdx });
  } catch (e) {
    return { ok: false, detail: e instanceof BackupV3Error ? e.message : String(e) };
  }
  try {
    mkdirSync(tempDir, { recursive: true });
    const staging = join(tempDir, "restore-test.sqlite");
    copyFileSync(opened.databasePath, staging);
    const expected = rs5Figures(opened.databasePath);
    const migrated = migrateFileForward(staging, migrationsDir).applied;
    const diff = rs5Diff(expected, rs5Figures(staging));
    if (diff.length) return { ok: false, detail: `RS-5: ${diff.slice(0, 5).join("; ")}` };
    return { ok: true, detail: `RS-5 identical${migrated.length ? ` after ${migrated.join(", ")}` : ""}` };
  } catch (e) {
    return { ok: false, detail: e instanceof Error ? e.message : String(e) };
  } finally {
    rmSync(opened.workDir, { recursive: true, force: true });
  }
}
