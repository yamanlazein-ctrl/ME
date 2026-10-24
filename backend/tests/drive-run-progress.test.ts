/**
 * Phase 4 — a real archive pass publishes its progress and ends in the right state.
 * Runs the production pass against a real temporary SQLite database and a scripted Drive.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

process.env.DB_ENGINE = "sqlite";
process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "motard-run-")), "data", "motard.db");
process.env.MOTARD_STARTUP_STATE = "FRESH";
process.env.MOTARD_INSTALLATION_ID ??= randomUUID();
process.env.MOTARD_INSTALL_INSTANCE_ID ??= randomUUID();
process.env.MOTARD_DATA_ID ??= randomUUID();
delete process.env.DATABASE_URL;
delete process.env.DESKTOP_SEED_PATH;
const sandbox = mkdtempSync(join(tmpdir(), "motard-run-bk-"));
process.env.MOTARD_BACKUP_REGISTRY = join(sandbox, "backups.json");

let writerDb: unknown;
let raw: import("better-sqlite3").Database;
let job: typeof import("../src/infrastructure/googledrive/monthlyArchiveJob.js");
let fmod: typeof import("../src/infrastructure/googledrive/folderOrganizer.js");
let qmod: typeof import("../src/infrastructure/googledrive/uploadQueue.js");
let emod: typeof import("../src/infrastructure/googledrive/exporters.js");
let live: typeof import("../src/infrastructure/googledrive/archiveRuns.js");

beforeAll(async () => {
  await import("../src/infrastructure/orm/sqlite/runtime.js").then((m) =>
    m.ensureSqliteRuntime({}),
  );
  const rt = (await import("../src/infrastructure/orm/sqlite/runtime.js")).getSqliteRuntime()!;
  raw = rt.conns.writer;
  writerDb = rt.conns.writerDb;
  job = await import("../src/infrastructure/googledrive/monthlyArchiveJob.js");
  fmod = await import("../src/infrastructure/googledrive/folderOrganizer.js");
  qmod = await import("../src/infrastructure/googledrive/uploadQueue.js");
  emod = await import("../src/infrastructure/googledrive/exporters.js");
  live = await import("../src/infrastructure/googledrive/archiveRuns.js");
  // The archive reads its settings from this row; the existing job test creates it the same way.
  const tenantId = randomUUID();
  raw.prepare(`INSERT INTO tenants (id, name, slug) VALUES (?, 'run', 'run-test')`).run(tenantId);
  raw.prepare(`INSERT INTO settings (id, tenant_id) VALUES (?, ?)`).run(randomUUID(), tenantId);
  // Documents to archive, seeded the same way the monthly-job test seeds them. Without these the pass has
  // nothing to upload, and a "pass whose uploads fail" test would pass vacuously.
  raw
    .prepare(
      `INSERT INTO parties (id, tenant_id, kind, name, currency) VALUES (?, ?, 'customer', 'Run C', 'SYP')`,
    )
    .run(randomUUID(), tenantId);
  const pid = raw.prepare(`SELECT id FROM parties WHERE name = 'Run C'`).get() as { id: string };
  const ins = raw.prepare(
    `INSERT INTO invoices (id, tenant_id, number, type, date, party_id, party_type, subtotal, total, paid, status)
     VALUES (?, ?, ?, 'sale', ?, ?, 'customer', 100, 100, 0, 'active')`,
  );
  ins.run(randomUUID(), tenantId, "R-1", "2026-10-03", pid.id);
  ins.run(randomUUID(), tenantId, "R-2", "2026-10-04", pid.id);
});

/** A scripted Drive that accepts every upload, or fails every upload when `failUploads` is set. */
function scriptedDrive(opts: { failUploads?: boolean } = {}) {
  const folders = new Map<string, string>();
  let seq = 0;
  const upload = async (_p: string, name: string) => {
    if (opts.failUploads) {
      const { DriveError } = await import("../src/infrastructure/googledrive/driveClient.js");
      throw new DriveError(400, "BAD_REQUEST", "scripted refusal", false);
    }
    seq++;
    return { id: `file-${seq}`, name, mimeType: "x" };
  };
  return {
    async findChild(parent: string, name: string) {
      const id = folders.get(`${parent}|${name}`);
      return id ? { id, name, mimeType: "folder" } : null;
    },
    async createFolder(parent: string | null, name: string) {
      const id = `fld-${folders.size + 1}`;
      folders.set(`${parent}|${name}`, id);
      return { id, name, mimeType: "folder" };
    },
    async findByAppKey() {
      return null;
    },
    async updateMedia(fileId: string) {
      return { id: fileId, name: "x", mimeType: "x" };
    },
    uploadSmall: upload,
    uploadResumable: upload,
    async uploadResumableFromFile(p: string, name: string) {
      return upload(p, name);
    },
    async getFile(id: string) {
      return { id, name: "x", mimeType: "x" };
    },
  };
}

function deps(drive: ReturnType<typeof scriptedDrive>) {
  const db = writerDb as never;
  const folders = new fmod.FolderOrganizer(db, drive as never);
  const queue = new qmod.UploadQueue(db, drive as never, folders);
  const exporters = new emod.Exporters(db);
  return { db, queue, folders, exporters, drive: drive as never, localDeviceId: "dev-run" };
}

describe("a real archive pass publishes its run", () => {
  it("a primary device's pass runs, and its published progress never exceeds its total", async () => {
    raw
      .prepare(`UPDATE settings SET drive = ?`)
      .run(JSON.stringify({ archiveEnabled: true, coordinatorDeviceId: "dev-run" }));
    const drive = scriptedDrive();
    const report = await job.runArchivePass(deps(drive), "manual");
    // Asserted, not conditional: a skipped pass fails this test instead of passing it vacuously.
    expect(report.skipped).toBeNull();
    const runRow = raw
      .prepare(`SELECT id, state FROM motard_drive_runs ORDER BY rowid DESC LIMIT 1`)
      .get() as { id: string; state: string };
    expect(["done", "partial", "failed", "cancelled"]).toContain(runRow.state);
    // The pass publishes its live progress on the run it is working on, and returns that run's id.
    expect(report.runId).toBeTruthy();
    const shown = live.getLiveRun(report.runId!);
    expect(shown).not.toBeNull();
    expect(shown!.progress.done).toBeLessThanOrEqual(shown!.progress.total);
  });

  it("a pass whose uploads all fail ends as failed or partial, never as done", async () => {
    raw
      .prepare(`UPDATE settings SET drive = ?`)
      .run(JSON.stringify({ archiveEnabled: true, coordinatorDeviceId: "dev-run" }));
    // The previous test uploaded the seeded documents, so the queue holds them as done. Seed a NEW document
    // (a new number, so a new queue identity) so this pass has fresh work that every upload refuses.
    const tid = raw.prepare(`SELECT tenant_id AS t FROM settings LIMIT 1`).get() as { t: string };
    const pid = raw.prepare(`SELECT id FROM parties WHERE name = 'Run C'`).get() as { id: string };
    raw
      .prepare(
        `INSERT INTO invoices (id, tenant_id, number, type, date, party_id, party_type, subtotal, total, paid, status)
         VALUES (?, ?, ?, 'sale', '2026-10-09', ?, 'customer', 77, 77, 0, 'active')`,
      )
      .run(randomUUID(), tid.t, "R-FAIL-9", pid.id);
    const drive = scriptedDrive({ failUploads: true });
    const report = await job.runArchivePass(deps(drive), "manual");
    expect(report.skipped).toBeNull();
    // The pass must have TRIED uploads, or the assertion below means nothing.
    expect(report.processed).toBeGreaterThan(0);
    const runRow = raw
      .prepare(`SELECT state FROM motard_drive_runs ORDER BY rowid DESC LIMIT 1`)
      .get() as { state: string };
    expect(runRow.state).not.toBe("done");
  });
});
