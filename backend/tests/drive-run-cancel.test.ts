/**
 * Remediation Stage 1 — B-01: a cancelled archive run must be recorded as 'cancelled'.
 *
 * Before migration 0007 the `motard_drive_runs_state` CHECK did not allow 'cancelled', even though
 * archiveRuns.finalState() has always produced it for a user-cancelled run. The final UPDATE of the
 * pass therefore threw, the caller caught it, rewrote the run as 'failed' and rethrew — so the
 * POST /drive/archive/runs request answered HTTP 500, and the run history recorded a deliberate
 * cancellation as a failure.
 *
 * These tests run the production pass against a real temporary SQLite database and a scripted
 * Drive whose upload is held open, so the cancel lands while the pass is genuinely in flight.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

process.env.DB_ENGINE = "sqlite";
process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "motard-cancel-")), "data", "motard.db");
process.env.MOTARD_STARTUP_STATE = "FRESH";
process.env.MOTARD_INSTALLATION_ID ??= randomUUID();
process.env.MOTARD_INSTALL_INSTANCE_ID ??= randomUUID();
process.env.MOTARD_DATA_ID ??= randomUUID();
delete process.env.DATABASE_URL;
delete process.env.DESKTOP_SEED_PATH;
const sandbox = mkdtempSync(join(tmpdir(), "motard-cancel-bk-"));
process.env.MOTARD_BACKUP_REGISTRY = join(sandbox, "backups.json");

let raw: import("better-sqlite3").Database;
let writerDb: unknown;
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

  const tenantId = randomUUID();
  raw
    .prepare(`INSERT INTO tenants (id, name, slug) VALUES (?, 'cancel', 'cancel-test')`)
    .run(tenantId);
  raw.prepare(`INSERT INTO settings (id, tenant_id) VALUES (?, ?)`).run(randomUUID(), tenantId);
  raw
    .prepare(
      `INSERT INTO parties (id, tenant_id, kind, name, currency) VALUES (?, ?, 'customer', 'Cancel C', 'SYP')`,
    )
    .run(randomUUID(), tenantId);
  const pid = raw.prepare(`SELECT id FROM parties WHERE name = 'Cancel C'`).get() as { id: string };
  const ins = raw.prepare(
    `INSERT INTO invoices (id, tenant_id, number, type, date, party_id, party_type, subtotal, total, paid, status)
     VALUES (?, ?, ?, 'sale', ?, ?, 'customer', 100, 100, 0, 'active')`,
  );
  ins.run(randomUUID(), tenantId, "C-1", "2026-10-03", pid.id);
  ins.run(randomUUID(), tenantId, "C-2", "2026-10-04", pid.id);
});

/** A scripted Drive whose uploads wait on a gate, so the cancel lands while the pass is in flight. */
function scriptedDrive(gate: Promise<void>) {
  const folders = new Map<string, string>();
  let seq = 0;
  const upload = async (_p: string, name: string) => {
    await gate;
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
  return { db, queue, folders, exporters, drive: drive as never, localDeviceId: "dev-cancel" };
}

/** Poll until the predicate holds, or fail loudly instead of hanging the suite. */
async function waitFor(predicate: () => boolean, what: string, ms = 10_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`timed out waiting for ${what}`);
}

describe("a cancelled archive run", () => {
  it("is stored as 'cancelled', not 'failed', and the pass does not throw", async () => {
    raw
      .prepare(`UPDATE settings SET drive = ?`)
      .run(JSON.stringify({ archiveEnabled: true, coordinatorDeviceId: "dev-cancel" }));

    let release!: () => void;
    const gate = new Promise<void>((r) => {
      release = r;
    });
    const drive = scriptedDrive(gate);

    const passPromise = job.runArchivePass(deps(drive), "manual");

    // Wait until the pass has really started uploading, then cancel it mid-flight.
    await waitFor(
      () =>
        raw
          .prepare(`SELECT count(*) AS n FROM motard_drive_uploads WHERE status = 'uploading'`)
          .get() !== undefined &&
        (
          raw
            .prepare(`SELECT count(*) AS n FROM motard_drive_uploads WHERE status = 'uploading'`)
            .get() as { n: number }
        ).n > 0,
      "the pass to start an upload",
    );
    const runId = live.currentLiveRunId();
    expect(runId).toBeTruthy();
    expect(live.cancelLiveRun(runId!)).toBe(true);
    release();

    // Before migration 0007 this promise REJECTED (the CHECK violation) and the route answered 500.
    await expect(passPromise).resolves.toBeDefined();

    const row = raw
      .prepare(
        `SELECT state, trigger, period_key, progress_done, progress_total FROM motard_drive_runs WHERE id = ?`,
      )
      .get(runId) as {
      state: string;
      trigger: string;
      period_key: string | null;
      progress_done: number;
      progress_total: number;
    };
    expect(row.state).toBe("cancelled");
    expect(row.state).not.toBe("failed");
  });

  it("records the run's trigger, period and progress columns (migration 0007)", async () => {
    raw
      .prepare(`UPDATE settings SET drive = ?`)
      .run(JSON.stringify({ archiveEnabled: true, coordinatorDeviceId: "dev-cancel" }));
    const drive = scriptedDrive(Promise.resolve());
    await job.runArchivePass(deps(drive), "manual");
    const row = raw
      .prepare(
        `SELECT trigger, period_key, progress_total, progress_done FROM motard_drive_runs
         ORDER BY started_at DESC LIMIT 1`,
      )
      .get() as {
      trigger: string;
      period_key: string | null;
      progress_total: number;
      progress_done: number;
    };
    expect(row.trigger).toBe("manual");
    expect(row.period_key).toMatch(/^\d{4}-\d{2}$/);
    expect(row.progress_total).toBeGreaterThanOrEqual(0);
    expect(row.progress_done).toBeGreaterThanOrEqual(0);
  });

  it("still rejects a state outside the allowed set", async () => {
    // The CHECK must stay a real guard: 'cancelled' joined the list, nothing else did.
    expect(() =>
      raw
        .prepare(
          `INSERT INTO motard_drive_runs (id, kind, state, trigger, started_at) VALUES (?, 'catchup', 'nonsense', 'manual', ?)`,
        )
        .run(randomUUID(), new Date().toISOString()),
    ).toThrow(/CHECK constraint failed/);
  });
});
