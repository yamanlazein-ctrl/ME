/**
 * DB-08: the Drive upload ledger is per-device runtime state (0005_drive_archive.sql). A backup must
 * not carry it — restoring device A's archive on device B would hand B A's "done" rows, so B's queue
 * dedupes and never uploads files that exist only in A's Drive — and a restore keeps the restoring
 * device's own ledger (same carry-over as the other device-bound tables).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import Database from "better-sqlite3";

const root = mkdtempSync(join(tmpdir(), "motard-bk-drive-"));
process.env.DB_ENGINE = "sqlite";
process.env.SQLITE_PATH = join(root, "data", "motard.db");
process.env.MOTARD_STARTUP_STATE = "FRESH";
process.env.MOTARD_INSTALLATION_ID ??= randomUUID();
process.env.MOTARD_INSTALL_INSTANCE_ID ??= randomUUID();
process.env.MOTARD_DATA_ID ??= randomUUID();
delete process.env.DATABASE_URL;
delete process.env.DESKTOP_SEED_PATH;

const DRIVE_TABLES = ["motard_drive_folders", "motard_drive_uploads", "motard_drive_runs"];
let runtime: typeof import("@/infrastructure/orm/sqlite/runtime.js");
let backup: typeof import("@/infrastructure/backup/sqliteBackup.js");
let restore: typeof import("@/infrastructure/backup/sqliteRestore.js");

const writer = () => runtime.getSqliteRuntime()!.conns.writer as unknown as Database.Database;
const now = new Date().toISOString();

beforeAll(async () => {
  runtime = await import("@/infrastructure/orm/sqlite/runtime.js");
  backup = await import("@/infrastructure/backup/sqliteBackup.js");
  restore = await import("@/infrastructure/backup/sqliteRestore.js");
  await runtime.ensureSqliteRuntime();
  const w = writer();
  w.prepare(`INSERT INTO tenants (id, name, slug) VALUES (?, 'درايف', 'bk-drive')`).run(randomUUID());
  w.prepare(`INSERT INTO motard_drive_folders (kind, drive_file_id, label, created_at) VALUES ('root', 'root-A', 'Motard', ?)`).run(now);
  w.prepare(
    `INSERT INTO motard_drive_uploads (id, stable_key, entity_type, entity_id, period_key, section, file_name, mime_type,
       content_sha256, content_bytes, status, drive_file_id, created_at, updated_at)
     VALUES ('up-A', 'k-A', 'invoice', 'f.csv', '2026-10', 'salesInvoices', 'f.csv', 'text/csv', 'h', 1, 'done', 'drive-A', ?, ?)`,
  ).run(now, now);
  w.prepare(`INSERT INTO motard_drive_runs (id, kind, state, started_at) VALUES ('run-A', 'catchup', 'done', ?)`).run(now);
});

afterAll(() => {
  runtime?.shutdownSqliteRuntime();
  rmSync(root, { recursive: true, force: true });
});

describe("backup excludes the per-device Drive ledger (DB-08)", () => {
  it("the archive carries no motard_drive_* rows, and a restore keeps this device's own ledger", async () => {
    const created = await backup.createAndVerifyBackup({ kind: "manual", appVersion: "test" });
    const opened = backup.openAndVerifyBackupV3Sync(created.path, { keep: true });
    const db = new Database(opened.databasePath, { readonly: true });
    const counts = Object.fromEntries(DRIVE_TABLES.map((t) => [t, db.prepare(`SELECT count(*) FROM "${t}"`).pluck().get()]));
    db.close();
    rmSync(opened.workDir, { recursive: true, force: true });
    expect(counts).toEqual(Object.fromEntries(DRIVE_TABLES.map((t) => [t, 0])));

    await restore.restoreBackupV3(created.path);
    const w = writer();
    expect(w.prepare(`SELECT drive_file_id FROM motard_drive_uploads WHERE id = 'up-A'`).pluck().get()).toBe("drive-A");
    expect(w.prepare(`SELECT count(*) FROM motard_drive_folders`).pluck().get()).toBe(1);
  });
});
