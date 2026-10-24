/**
 * When is a period "archived"? The coverage rules of the Drive archive pass, end to end against a
 * real temporary SQLite database and a stateful fake Drive.
 *
 * Each case below was a silent gap: the pass recorded a period as archived (or did nothing) while
 * documents of that period never reached Drive.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

process.env.DB_ENGINE = "sqlite";
process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "motard-cov-")), "data", "motard.db");
process.env.MOTARD_STARTUP_STATE = "FRESH";
process.env.MOTARD_INSTALLATION_ID ??= randomUUID();
process.env.MOTARD_INSTALL_INSTANCE_ID ??= randomUUID();
process.env.MOTARD_DATA_ID ??= randomUUID();
delete process.env.DATABASE_URL;
delete process.env.DESKTOP_SEED_PATH;
const sandbox = mkdtempSync(join(tmpdir(), "motard-cov-files-"));
process.env.MOTARD_BACKUP_REGISTRY = join(sandbox, "backups.json");

let raw: import("better-sqlite3").Database;
let writerDb: unknown;
let job: typeof import("../src/infrastructure/googledrive/monthlyArchiveJob.js");
let fmod: typeof import("../src/infrastructure/googledrive/folderOrganizer.js");
let qmod: typeof import("../src/infrastructure/googledrive/uploadQueue.js");
let emod: typeof import("../src/infrastructure/googledrive/exporters.js");
let bridge: typeof import("../src/infrastructure/googledrive/renderBridge.js");
let docs: typeof import("../src/infrastructure/googledrive/archiveDocuments.js");
let tenantId: string;
let partyId: string;

/** `YYYY-MM` of the month `back` months before the current UTC month. */
function monthBack(back: number): string {
  const now = new Date();
  const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - back, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, "0")}`;
}
const P1 = monthBack(2); // an older closed month
const P2 = monthBack(1); // the month that just ended

/** A stateful fake Drive: files stored by key; uploads can be made to fail. */
class FakeDrive {
  files: Array<{ id: string; name: string; appKey: string | null }> = [];
  uploads = 0;
  updates = 0;
  failNextUploads = 0;
  private folders = new Map<string, string>();
  private seq = 0;
  async findChild(parent: string, name: string) {
    const id = this.folders.get(`${parent}|${name}`);
    return id ? { id, name, mimeType: "folder" } : null;
  }
  async createFolder(parent: string | null, name: string) {
    const id = `fld-${this.folders.size + 1}`;
    this.folders.set(`${parent}|${name}`, id);
    return { id, name, mimeType: "folder" };
  }
  async findByAppKey(appKey: string) {
    const f = this.files.find((x) => x.appKey === appKey);
    return f ? { id: f.id, name: f.name, mimeType: "x" } : null;
  }
  async updateMedia(fileId: string, _mime: string, _content: Uint8Array, name?: string) {
    const f = this.files.find((x) => x.id === fileId)!;
    this.updates++;
    if (name) f.name = name;
    return { id: f.id, name: f.name, mimeType: "x" };
  }
  async updateAppProperties(fileId: string) {
    return { id: fileId, name: "x", mimeType: "x" };
  }
  async uploadSmall(_p: string, name: string, _m: string, _c: Uint8Array, appKey?: string) {
    if (this.failNextUploads > 0) {
      this.failNextUploads--;
      const { DriveError } = await import("../src/infrastructure/googledrive/driveClient.js");
      throw new DriveError(500, "backendError", "boom", true);
    }
    return this.create(name, appKey);
  }
  async uploadResumable(_p: string, name: string, _m: string, _c: Uint8Array, appKey?: string) {
    return this.create(name, appKey);
  }
  async uploadResumableFromFile(
    _p: string,
    name: string,
    _m: string,
    _f: string,
    _s: number,
    appKey?: string,
  ) {
    return this.create(name, appKey);
  }
  private create(name: string, appKey?: string) {
    this.uploads++;
    const id = `file-${++this.seq}`;
    this.files.push({ id, name, appKey: appKey ?? null });
    return { id, name, mimeType: "x" };
  }
  async getFile(id: string) {
    const f = this.files.find((x) => x.id === id);
    return f ? { id: f.id, name: f.name, mimeType: "x" } : null;
  }
}

function deps(drive: FakeDrive) {
  const db = writerDb as never;
  const folders = new fmod.FolderOrganizer(db, drive as never);
  const queue = new qmod.UploadQueue(db, drive as never, folders);
  return {
    db,
    queue,
    folders,
    exporters: new emod.Exporters(db),
    drive: drive as never,
    localDeviceId: "dev-cov",
  };
}

function addInvoice(number: string, date: string): string {
  const id = randomUUID();
  raw
    .prepare(
      `INSERT INTO invoices (id, tenant_id, number, type, date, party_id, party_type, subtotal, total, paid, status)
       VALUES (?, ?, ?, 'sale', ?, ?, 'customer', 10000, 10000, 0, 'active')`,
    )
    .run(id, tenantId, number, date, partyId);
  return id;
}

function runState(period: string): string | undefined {
  const row = raw
    .prepare(
      `SELECT state FROM motard_drive_runs WHERE kind = 'documents' AND period_key = ?
       ORDER BY started_at DESC, rowid DESC LIMIT 1`,
    )
    .get(period) as { state: string } | undefined;
  return row?.state;
}

/** Make every failed upload due now (the pass's back-off would otherwise wait minutes). */
function makeRetriesDue(): void {
  raw
    .prepare(`UPDATE motard_drive_uploads SET next_attempt_at = ? WHERE status = 'failed'`)
    .run(new Date(Date.now() - 1000).toISOString());
}

beforeAll(async () => {
  const runtime = await import("../src/infrastructure/orm/sqlite/runtime.js");
  await runtime.ensureSqliteRuntime({});
  const rt = runtime.getSqliteRuntime()!;
  raw = rt.conns.writer;
  writerDb = rt.conns.writerDb;
  job = await import("../src/infrastructure/googledrive/monthlyArchiveJob.js");
  fmod = await import("../src/infrastructure/googledrive/folderOrganizer.js");
  qmod = await import("../src/infrastructure/googledrive/uploadQueue.js");
  emod = await import("../src/infrastructure/googledrive/exporters.js");
  bridge = await import("../src/infrastructure/googledrive/renderBridge.js");
  docs = await import("../src/infrastructure/googledrive/archiveDocuments.js");

  tenantId = randomUUID();
  raw.prepare(`INSERT INTO tenants (id, name, slug) VALUES (?, 'cov', 'cov-test')`).run(tenantId);
  raw.prepare(`INSERT INTO settings (id, tenant_id) VALUES (?, ?)`).run(randomUUID(), tenantId);
  partyId = randomUUID();
  raw
    .prepare(
      `INSERT INTO parties (id, tenant_id, kind, name, currency) VALUES (?, ?, 'customer', 'Gamma', 'SYP')`,
    )
    .run(partyId, tenantId);
  raw
    .prepare(`UPDATE settings SET drive = ?`)
    .run(JSON.stringify({ archiveEnabled: true, coordinatorDeviceId: "dev-cov" }));
});

/** Every case starts with no documents, no queue and no run history. */
beforeEach(() => {
  raw.prepare(`DELETE FROM motard_drive_uploads`).run();
  raw.prepare(`DELETE FROM motard_drive_runs`).run();
  raw.prepare(`DELETE FROM motard_drive_folders`).run();
  raw.prepare(`DELETE FROM motard_drive_renders`).run();
  raw.prepare(`DELETE FROM invoices`).run();
  writeFileSync(process.env.MOTARD_BACKUP_REGISTRY!, JSON.stringify({ version: 1, entries: [] }));
});

describe("Drive archive coverage", () => {
  it("does not record a period as archived while its files are still queued", async () => {
    addInvoice("C-1", `${P1}-10`);
    addInvoice("C-2", `${P2}-10`);
    const drive = new FakeDrive();
    drive.failNextUploads = 1; // the first upload fails, the pass stops there

    await job.runArchivePass(deps(drive), "timer");

    // One file failed and the pass stopped: the other period's file was never reached. Neither
    // period may read as archived — the old pass recorded the unreached one as `done`.
    expect(drive.uploads).toBe(0);
    expect(runState(P1)).not.toBe("done");
    expect(runState(P2)).not.toBe("done");

    // The next tick picks both up again and finishes them.
    makeRetriesDue();
    await job.runArchivePass(deps(drive), "timer");
    expect(drive.uploads).toBe(2);
    expect(runState(P1)).toBe("done");
    expect(runState(P2)).toBe("done");

    const third = await job.runArchivePass(deps(drive), "timer");
    expect(third.skipped).toBe("NOTHING_TO_DO");
  });

  it("does not let a run of the still-open month cover it after the month ended", async () => {
    addInvoice("C-3", `${P2}-28`);
    // A run of P2 that was taken DURING P2 (a manual "upload now" before the month closed).
    raw
      .prepare(
        `INSERT INTO motard_drive_runs (id, period_key, kind, state, trigger, started_at, finished_at)
         VALUES (?, ?, 'documents', 'done', 'manual', ?, ?)`,
      )
      .run(randomUUID(), P2, `${P2}-15T10:00:00.000Z`, `${P2}-15T10:01:00.000Z`);
    const drive = new FakeDrive();

    const report = await job.runArchivePass(deps(drive), "timer");

    // The invoice dated after that run must still be archived once the month is over.
    expect(report.periods).toContain(P2);
    expect(drive.files.some((f) => f.name.includes("C-3"))).toBe(true);
  });

  it("archives an invoice again when it was edited after its month was archived", async () => {
    const id = addInvoice("C-4", `${P2}-05`);
    const drive = new FakeDrive();
    await job.runArchivePass(deps(drive), "timer");
    expect(runState(P2)).toBe("done");
    expect(drive.updates).toBe(0);

    // The invoice is cancelled later; its updated_at moves past the archive run.
    const later = new Date(Date.now() + 5_000).toISOString().replace(/Z$/, "000Z");
    raw
      .prepare(`UPDATE invoices SET status = 'cancelled', updated_at = ? WHERE id = ?`)
      .run(later, id);
    const report = await job.runArchivePass(deps(drive), "timer");

    expect(report.periods).toContain(P2);
    // The same Drive file is updated in place, now carrying the cancelled marker.
    expect(drive.updates).toBeGreaterThan(0);
    expect(drive.files.filter((f) => f.name.includes("C-4"))).toHaveLength(1);
    expect(drive.files.find((f) => f.name.includes("C-4"))!.name).toContain("ملغاة");
  });

  it("uploads a newer verified backup even when every period is archived", async () => {
    addInvoice("C-5", `${P2}-07`);
    const drive = new FakeDrive();
    await job.runArchivePass(deps(drive), "timer");
    const uploads = drive.uploads;

    // A new automatic backup was verified after the months were archived.
    const backup = join(sandbox, "backup-new.zip");
    writeFileSync(backup, "zip-bytes");
    writeFileSync(
      process.env.MOTARD_BACKUP_REGISTRY!,
      JSON.stringify({
        version: 1,
        entries: [
          {
            path: backup,
            kind: "automatic",
            createdAt: new Date().toISOString(),
            status: "VERIFIED",
          },
        ],
      }),
    );
    const report = await job.runArchivePass(deps(drive), "timer");

    expect(report.periods).toEqual([]);
    expect(drive.uploads).toBe(uploads + 1);
    expect(drive.files.some((f) => f.name === "backup-new.zip")).toBe(true);
  });

  it("uploads the rendered invoice PDF and clears it from the staging folder", async () => {
    addInvoice("C-6", `${P2}-12`);
    docs.resetRenderAvailability();
    const drive = new FakeDrive();
    const staged: string[] = [];
    // A fake shell: it pulls the render requests and stages a PDF for each one.
    let shellOn = true;
    const shell = (async () => {
      while (shellOn) {
        for (const req of await bridge.pendingRenders(writerDb as never)) {
          const dir = join(sandbox, "archive-staging", req.runId);
          mkdirSync(dir, { recursive: true });
          const path = join(dir, req.outName);
          writeFileSync(path, `%PDF-1.7 ${req.artifactId}\n%%EOF`);
          staged.push(path);
          await bridge.completeRender(writerDb as never, req.id, { path });
        }
        await new Promise((r) => setTimeout(r, 25));
      }
    })();
    try {
      await job.runArchivePass(deps(drive), "timer");
    } finally {
      shellOn = false;
      await shell;
    }

    const pdf = drive.files.find((f) => f.name.endsWith(".pdf"));
    expect(pdf).toBeDefined();
    expect(pdf!.name).toContain("C-6");
    expect(staged.length).toBeGreaterThan(0);
    expect(staged.every((p) => !existsSync(p))).toBe(true);
    // The render requests are not kept once their outcome is known.
    expect(await bridge.pendingRenders(writerDb as never)).toHaveLength(0);
  });
});
