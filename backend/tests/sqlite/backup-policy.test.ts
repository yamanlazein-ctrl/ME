/**
 * US4 backup policy on SQLite (specs/001-desktop-sqlite-engine T096, T097, T099; OQ-5, OQ-6, BK-4):
 *   - pre-operation backups are VERIFIED before the operation; a failed one blocks it (503, nothing ran)
 *   - automatic backups: VERIFIED, mirrored with a matching sha256, 7 kept, nothing else pruned
 *   - weekly restore-test: runs once per 7 days, records RS-5 in backups.json, leaves no temp dir
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, readdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type Database from "better-sqlite3";

const root = mkdtempSync(join(tmpdir(), "motard-bkp-"));
const mirror = mkdtempSync(join(tmpdir(), "motard-bkp-mirror-"));
process.env.DB_ENGINE = "sqlite";
process.env.SQLITE_PATH = join(root, "data", "motard.db");
process.env.MOTARD_STARTUP_STATE = "FRESH";
delete process.env.DATABASE_URL;
delete process.env.DESKTOP_SEED_PATH;
const prevMirror = process.env.BACKUP_MIRROR_DIR;
process.env.BACKUP_MIRROR_DIR = mirror;

const sha = (p: string) => createHash("sha256").update(readFileSync(p)).digest("hex");
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Mods = {
  runtime: typeof import("@/infrastructure/orm/sqlite/runtime.js");
  preop: typeof import("@/infrastructure/backup/preOperationBackup.js");
  sched: typeof import("@/infrastructure/backup/sqliteBackupScheduler.js");
  registry: typeof import("@/infrastructure/backup/backupRegistry.js");
  backup: typeof import("@/infrastructure/backup/sqliteBackup.js");
};
let m: Mods;

beforeAll(async () => {
  m = {
    runtime: await import("@/infrastructure/orm/sqlite/runtime.js"),
    preop: await import("@/infrastructure/backup/preOperationBackup.js"),
    sched: await import("@/infrastructure/backup/sqliteBackupScheduler.js"),
    registry: await import("@/infrastructure/backup/backupRegistry.js"),
    backup: await import("@/infrastructure/backup/sqliteBackup.js"),
  };
  await m.runtime.ensureSqliteRuntime();
  const w = m.runtime.getSqliteRuntime()!.conns.writer as unknown as Database.Database;
  const tenant = randomUUID();
  w.prepare(`INSERT INTO tenants (id, name, slug) VALUES (?, 'شركة السياسة', 'pol')`).run(tenant);
  w.prepare(`INSERT INTO parties (id, tenant_id, kind, name) VALUES (?, ?, 'customer', 'زبون')`).run(randomUUID(), tenant);
}, 120_000);

afterAll(() => {
  m?.runtime.shutdownSqliteRuntime();
  if (prevMirror === undefined) delete process.env.BACKUP_MIRROR_DIR;
  else process.env.BACKUP_MIRROR_DIR = prevMirror;
  rmSync(root, { recursive: true, force: true });
  rmSync(mirror, { recursive: true, force: true });
});

function fakeRes() {
  const out: { status?: number; body?: unknown } = {};
  const res = {
    status(c: number) { out.status = c; return res; },
    json(b: unknown) { out.body = b; return res; },
  };
  return { res: res as never, out };
}

describe("pre-operation backups (BK-4, T097)", () => {
  it("creates a VERIFIED pre-operation backup and lets the operation proceed", async () => {
    const { res, out } = fakeRes();
    expect(await m.preop.guardWithPreOperationBackup(res, "year-close")).toBe(true);
    expect(out.status).toBeUndefined();
    const e = m.registry.verifiedBackups("pre-operation")[0];
    expect(e?.path).toMatch(/pre-operation-year-close-/);
    expect(sha(e!.path)).toBe(e!.sha256);
  }, 60_000);

  it("a failed backup blocks the operation with 503 and an explicit message", async () => {
    const backups = join(root, "backups");
    const blocked = join(root, "backups-blocked");
    // make <root>\backups unusable: a FILE where the directory must be
    rmSync(blocked, { recursive: true, force: true });
    renameSync(backups, blocked);
    writeFileSync(backups, "not a directory");
    try {
      const { res, out } = fakeRes();
      expect(await m.preop.guardWithPreOperationBackup(res, "party-purge")).toBe(false);
      expect(out.status).toBe(503);
      expect(out.body).toMatchObject({ code: "PRE_OPERATION_BACKUP_FAILED" });
      expect(String((out.body as { message: string }).message)).toContain("لم تُنفَّذ");
    } finally {
      rmSync(backups, { force: true });
      renameSync(blocked, backups);
    }
  }, 60_000);

  it("is a no-op off SQLite (PostgreSQL / cloud unchanged)", async () => {
    const { config } = (await import("@/infrastructure/config/env.js")) as { config: { DB_ENGINE: string } };
    const prev = config.DB_ENGINE;
    config.DB_ENGINE = "postgres";
    try {
      expect(await m.preop.preOperationBackup("dye-purge")).toBeNull();
    } finally {
      config.DB_ENGINE = prev;
    }
  });
});

describe("automatic backups and retention (OQ-5, T096)", () => {
  it("creates a VERIFIED automatic backup with a hash-checked mirror copy", async () => {
    const path = await m.sched.runAutomaticBackupNow();
    expect(path).toBeTruthy();
    const e = m.registry.readRegistry().entries.find((x) => x.path === path)!;
    expect(e.status).toBe("VERIFIED");
    expect(e.kind).toBe("automatic");
    expect(e.mirrorPath && existsSync(e.mirrorPath)).toBeTruthy();
    expect(sha(e.mirrorPath!)).toBe(e.sha256);
    expect(readdirSync(mirror).some((f) => f.endsWith(".partial"))).toBe(false);
  }, 60_000);

  it("keeps the 7 newest VERIFIED automatic backups and never prunes other kinds", async () => {
    const manual = await m.backup.createAndVerifyBackup({ kind: "manual" });
    for (let i = 0; i < 8; i++) {
      await sleep(5); // distinct timestamps in the file names
      await m.sched.runAutomaticBackupNow();
    }
    const autos = m.registry.verifiedBackups("automatic");
    expect(autos).toHaveLength(7);
    expect(existsSync(manual.path)).toBe(true);
    expect(m.registry.verifiedBackups("manual").some((e) => e.path === manual.path)).toBe(true);
    expect(m.registry.verifiedBackups("pre-operation").length).toBeGreaterThanOrEqual(1);
    // the mirror holds exactly the kept automatic files
    const mirrored = readdirSync(mirror).filter((f) => f.startsWith("automatic-"));
    expect(mirrored.sort()).toEqual(autos.map((e) => e.mirrorPath!.split(/[\\/]/).at(-1)!).sort());
  }, 300_000);
});

describe("weekly restore-test (OQ-6, T099)", () => {
  it("runs, records RS-5 identical in backups.json and leaves no temp directory", () => {
    const before = readdirSync(tmpdir()).filter((d) => d.startsWith("motard-restore-test-")).length;
    const r = m.sched.runWeeklyRestoreTestIfDue();
    expect(r).toMatchObject({ ran: true, ok: true });
    expect(r.detail).toMatch(/RS-5 identical/);
    const newest = m.registry.verifiedBackups("automatic")[0];
    expect(newest.lastRestoreTest).toMatchObject({ ok: true });
    expect(readdirSync(tmpdir()).filter((d) => d.startsWith("motard-restore-test-")).length).toBe(before);
  }, 120_000);

  it("runs at most once per 7 days", () => {
    expect(m.sched.runWeeklyRestoreTestIfDue().ran).toBe(false);
    expect(m.sched.runWeeklyRestoreTestIfDue(Date.now() + 6 * 86_400_000).ran).toBe(false);
    expect(m.sched.runWeeklyRestoreTestIfDue(Date.now() + 8 * 86_400_000).ran).toBe(true);
  }, 120_000);
});
