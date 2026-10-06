/**
 * T085 "Restore a backup" at startup (specs/001-desktop-sqlite-engine US3): the desktop runtime moved
 * the previous data aside and spawns the server FRESH with MOTARD_RESTORE_ARCHIVE. The boot must
 * restore that archive before serving and stamp db-meta.json with the RESTORED company's identity —
 * and a rejected archive must fail the boot (the runtime then puts the previous data back).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

const source = mkdtempSync(join(tmpdir(), "motard-sr-src-"));
const target = mkdtempSync(join(tmpdir(), "motard-sr-dst-"));
const rejected = mkdtempSync(join(tmpdir(), "motard-sr-bad-"));
process.env.DB_ENGINE = "sqlite";
process.env.SQLITE_PATH = join(source, "data", "motard.db");
process.env.MOTARD_STARTUP_STATE = "FRESH";
delete process.env.DATABASE_URL;
delete process.env.DESKTOP_SEED_PATH;

const TENANT = randomUUID();
const PARTY = randomUUID();

type Mods = {
  runtime: typeof import("@/infrastructure/orm/sqlite/runtime.js");
  backup: typeof import("@/infrastructure/backup/sqliteBackup.js");
  migrations: typeof import("@/infrastructure/orm/runDesktopMigrations.js");
  config: { SQLITE_PATH?: string; MOTARD_STARTUP_STATE?: string };
};
let m: Mods;
let archive = "";
let sourceDataId = "";
let sourceMetaTenant: string | null = null;
const writer = () => m.runtime.getSqliteRuntime()!.conns.writer as unknown as Database.Database;

function bootFreshOn(root: string, restore: string) {
  m.runtime.shutdownSqliteRuntime();
  m.config.SQLITE_PATH = join(root, "data", "motard.db");
  m.config.MOTARD_STARTUP_STATE = "FRESH";
  process.env.MOTARD_RESTORE_ARCHIVE = restore;
  process.env.DESKTOP_DB_META_PATH = join(root, "db-meta.json");
  return m.migrations.runDesktopMigrations();
}

beforeAll(async () => {
  m = {
    runtime: await import("@/infrastructure/orm/sqlite/runtime.js"),
    backup: await import("@/infrastructure/backup/sqliteBackup.js"),
    migrations: await import("@/infrastructure/orm/runDesktopMigrations.js"),
    config: (await import("@/infrastructure/config/env.js")).config as never,
  };
  await m.runtime.ensureSqliteRuntime();
  const db = writer();
  db.prepare(`INSERT INTO tenants (id, name, slug) VALUES (?, 'شركة الاستعادة', 'sr')`).run(TENANT);
  db.prepare(`INSERT INTO parties (id, tenant_id, kind, name) VALUES (?, ?, 'customer', 'زبون الاستعادة')`).run(PARTY, TENANT);
  sourceDataId = String(db.prepare(`SELECT data_id FROM motard_meta WHERE id = 1`).pluck().get());
  sourceMetaTenant = db.prepare(`SELECT tenant_id FROM motard_meta WHERE id = 1`).pluck().get() as string | null;
  archive = (await m.backup.createAndVerifyBackup({ kind: "manual", appVersion: "test" })).path;
}, 120_000);

afterAll(() => {
  m?.runtime.shutdownSqliteRuntime();
  delete process.env.MOTARD_RESTORE_ARCHIVE;
  delete process.env.DESKTOP_DB_META_PATH;
  for (const d of [source, target, rejected]) rmSync(d, { recursive: true, force: true });
});

describe("startup restore (MOTARD_RESTORE_ARCHIVE)", () => {
  it("restores the chosen archive before serving and stamps the restored identity", async () => {
    await bootFreshOn(target, archive);
    const db = writer();
    expect(db.prepare(`SELECT name FROM parties WHERE id = ?`).pluck().get(PARTY)).toBe("زبون الاستعادة");
    const dataId = db.prepare(`SELECT data_id FROM motard_meta WHERE id = 1`).pluck().get();
    expect(dataId).toBe(sourceDataId);
    expect(db.prepare(`SELECT restored_from FROM motard_meta WHERE id = 1`).pluck().get()).toBeTruthy();
    const meta = JSON.parse(readFileSync(join(target, "db-meta.json"), "utf8"));
    expect(meta).toMatchObject({ engine: "sqlite", data_id: sourceDataId, tenant_id: sourceMetaTenant });
  }, 120_000);

  it("a rejected archive fails the boot — nothing is served from a half-restored database", async () => {
    const bad = join(rejected, "not-a-backup.zip");
    writeFileSync(bad, "this is not a Motard backup");
    await expect(bootFreshOn(rejected, bad)).rejects.toBeTruthy();
  }, 120_000);
});
