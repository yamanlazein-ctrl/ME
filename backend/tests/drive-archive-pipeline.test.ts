/**
 * End-to-end Drive archive pipeline on a real temporary SQLite database with a byte-capturing fake
 * Drive (audit D-03, D-06, D-08, D-09, D-10). The existing drive tests injected bytes by hand, so an
 * empty-file upload in production stayed green; these assert what actually reaches Drive.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID, createHash } from "node:crypto";

process.env.DB_ENGINE = "sqlite";
process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "motard-pipe-")), "data", "motard.db");
process.env.MOTARD_STARTUP_STATE = "FRESH";
process.env.MOTARD_INSTALLATION_ID ??= randomUUID();
process.env.MOTARD_INSTALL_INSTANCE_ID ??= randomUUID();
process.env.MOTARD_DATA_ID ??= randomUUID();
delete process.env.DATABASE_URL;
delete process.env.DESKTOP_SEED_PATH;
const sandbox = mkdtempSync(join(tmpdir(), "motard-pipe-bk-"));
process.env.MOTARD_BACKUP_REGISTRY = join(sandbox, "backups.json");

type Mods = {
  job: typeof import("../src/infrastructure/googledrive/monthlyArchiveJob.js");
  q: typeof import("../src/infrastructure/googledrive/uploadQueue.js");
  f: typeof import("../src/infrastructure/googledrive/folderOrganizer.js");
  e: typeof import("../src/infrastructure/googledrive/exporters.js");
  d: typeof import("../src/infrastructure/googledrive/driveClient.js");
};
let m: Mods;
let raw: import("better-sqlite3").Database;
let db: never;

function fakeDrive() {
  const uploads: Array<{ name: string; bytes: Uint8Array }> = [];
  const folders = new Map<string, string>();
  let failNext: Error | null = null;
  const upload = async (_parent: string, name: string, _mime: string, bytes: Uint8Array) => {
    if (failNext) {
      const e = failNext;
      failNext = null;
      throw e;
    }
    uploads.push({ name, bytes });
    return { id: `file-${uploads.length}`, name, mimeType: "x" };
  };
  return {
    uploads,
    failWith(e: Error) {
      failNext = e;
    },
    async findChild(parent: string, name: string) {
      const id = folders.get(`${parent}|${name}`);
      return id ? { id, name, mimeType: "folder" } : null;
    },
    async createFolder(parent: string | null, name: string) {
      const id = `fld-${folders.size + 1}`;
      folders.set(`${parent}|${name}`, id);
      return { id, name, mimeType: "folder" };
    },
    uploadSmall: upload,
    uploadResumable: upload,
    // Phase 4: the streamed path reads the file from disk; the fake records the same bytes the buffered
    // path would, so the assertions about uploaded content are unchanged.
    async uploadResumableFromFile(parent: string, name: string, mime: string, filePath: string) {
      const { readFileSync } = await import("node:fs");
      return upload(parent, name, mime, new Uint8Array(readFileSync(filePath)));
    },
    // Phase 2 upsert: no existing file carries an app key in this fake, so uploads create new files.
    async findByAppKey(_appKey: string, _parentId?: string) {
      return null;
    },
    async updateMedia(fileId: string, _mime: string, _content: Uint8Array) {
      return { id: fileId, name: "x", mimeType: "x" };
    },
    async getFile(id: string) {
      return { id, name: "x", mimeType: "x" };
    },
  };
}

function deps(drive: ReturnType<typeof fakeDrive> | null, localDeviceId: string | null) {
  const folders = new m.f.FolderOrganizer(db, drive as never);
  const queue = new m.q.UploadQueue(db, drive as never, folders);
  return {
    db,
    queue,
    folders,
    exporters: new m.e.Exporters(db),
    drive: drive as never,
    localDeviceId,
  };
}

const status = (id: string) =>
  (raw
    .prepare(
      `SELECT status, lease_token AS lease, next_attempt_at AS next FROM motard_drive_uploads WHERE id = ?`,
    )
    .get(id) ?? null) as { status: string; lease: string | null; next: string | null } | null;

beforeAll(async () => {
  const rtm = await import("../src/infrastructure/orm/sqlite/runtime.js");
  await rtm.ensureSqliteRuntime({});
  raw = rtm.getSqliteRuntime()!.conns.writer;
  db = (await import("../src/infrastructure/orm/sqlite/transaction.js")).sqliteDb() as never;
  m = {
    job: await import("../src/infrastructure/googledrive/monthlyArchiveJob.js"),
    q: await import("../src/infrastructure/googledrive/uploadQueue.js"),
    f: await import("../src/infrastructure/googledrive/folderOrganizer.js"),
    e: await import("../src/infrastructure/googledrive/exporters.js"),
    d: await import("../src/infrastructure/googledrive/driveClient.js"),
  };
  const tenantId = randomUUID();
  raw.prepare(`INSERT INTO tenants (id, name, slug) VALUES (?, 't', 'pipe')`).run(tenantId);
  raw
    .prepare(`INSERT INTO settings (id, tenant_id, drive) VALUES (?, ?, ?)`)
    .run(
      randomUUID(),
      tenantId,
      JSON.stringify({ archiveEnabled: true, coordinatorDeviceId: "dev-primary" }),
    );
  const pid = randomUUID();
  raw
    .prepare(
      `INSERT INTO parties (id, tenant_id, kind, name, currency) VALUES (?, ?, 'customer', 'زبون', 'SYP')`,
    )
    .run(pid, tenantId);
  const now = new Date();
  const thisMonth = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-02`;
  raw
    .prepare(
      `INSERT INTO invoices (id, tenant_id, number, type, date, party_id, party_type, subtotal, total, paid, status)
     VALUES (?, ?, 'PIPE-77', 'sale', ?, ?, 'customer', 100, 100, 0, 'active')`,
    )
    .run(randomUUID(), tenantId, thisMonth, pid);
});

describe("settings.drive column (DB-07)", () => {
  it("refuses non-JSON like every sibling settings column (a bad value would throw on every settings read)", () => {
    expect(() => raw.prepare(`UPDATE settings SET drive = 'not json'`).run()).toThrow(
      /CHECK constraint failed/,
    );
    expect(() => raw.prepare(`UPDATE settings SET drive = NULL`).run()).not.toThrow();
    raw
      .prepare(`UPDATE settings SET drive = ?`)
      .run(JSON.stringify({ archiveEnabled: true, coordinatorDeviceId: "dev-primary" }));
  });
});

describe("Drive archive pipeline", () => {
  it("a secondary device enqueues nothing and uploads nothing (fail-closed before any export)", async () => {
    const drive = fakeDrive();
    const r = await m.job.runArchivePass(deps(drive, "dev-secondary"), "manual");
    expect(r.skipped).toBe("NOT_COORDINATOR");
    expect(r.enqueued).toBe(0);
    expect(
      (raw.prepare(`SELECT count(*) AS n FROM motard_drive_uploads`).get() as { n: number }).n,
    ).toBe(0);
  });

  it("D-03: the uploaded invoice file carries the exporter's bytes, not an empty body", async () => {
    const drive = fakeDrive();
    await m.job.runArchivePass(deps(drive, "dev-primary"), "manual");
    const inv = drive.uploads.find((u) => u.name.includes("PIPE-77"));
    expect(inv).toBeDefined();
    expect(inv!.bytes.length).toBeGreaterThan(10);
    expect(new TextDecoder().decode(inv!.bytes)).toContain("PIPE-77");
  });

  it("D-06/D-10: the newest VERIFIED backup is uploaded with its bytes and its job completes", async () => {
    const file = join(sandbox, "auto-1.zip");
    writeFileSync(file, "backup-bytes-123");
    writeFileSync(
      process.env.MOTARD_BACKUP_REGISTRY!,
      JSON.stringify({
        version: 1,
        entries: [
          {
            path: file,
            kind: "automatic",
            createdAt: new Date().toISOString(),
            status: "VERIFIED",
            sha256: createHash("sha256").update("backup-bytes-123").digest("hex"),
          },
        ],
      }),
    );
    const drive = fakeDrive();
    await m.job.runArchivePass(deps(drive, "dev-primary"), "manual");
    const up = drive.uploads.find((u) => u.name === "auto-1.zip");
    expect(up).toBeDefined();
    expect(new TextDecoder().decode(up!.bytes)).toBe("backup-bytes-123");
    const row = raw
      .prepare(
        `SELECT status, lease_token AS lease FROM motard_drive_uploads WHERE entity_type = 'db_backup'`,
      )
      .get() as {
      status: string;
      lease: string | null;
    };
    expect(row).toEqual({ status: "done", lease: null });
  });

  it("D-10: a job whose source vanished is removed, not leased and reclaimed forever", async () => {
    const d = deps(fakeDrive(), "dev-primary");
    const { id } = await d.queue.enqueue({
      entityType: "invoice",
      entityId: "gone.csv",
      businessDate: "2026-01-05",
      section: "salesInvoices",
      fileName: "gone.csv",
      mimeType: "text/csv",
      content: "x",
      deviceId: "dev-primary",
    });
    await m.job.runArchivePass(d, "manual");
    expect(status(id)).toBeNull();
  });

  it("D-08: two concurrent claims of one due row — exactly one wins", async () => {
    const d = deps(fakeDrive(), "dev-primary");
    await d.queue.enqueue({
      entityType: "invoice",
      entityId: "race.csv",
      businessDate: "2026-02-05",
      section: "salesInvoices",
      fileName: "race.csv",
      mimeType: "text/csv",
      content: "race",
      deviceId: "dev-primary",
    });
    const [a, b] = await Promise.all([d.queue.claim("w1"), d.queue.claim("w2")]);
    expect([a, b].filter(Boolean)).toHaveLength(1);
  });

  it("D-09: a permanent Drive error is 'blocked'; a retryable one stays 'failed' with a next attempt", async () => {
    const drive = fakeDrive();
    const d = deps(drive, "dev-primary");
    const mk = async (entityId: string) => {
      await d.queue.enqueue({
        entityType: "invoice",
        entityId,
        businessDate: "2026-03-05",
        section: "salesInvoices",
        fileName: entityId,
        mimeType: "text/csv",
        content: entityId,
        deviceId: "dev-primary",
      });
      let job = await d.queue.claim("w");
      while (job && job.entityId !== entityId) job = await d.queue.claim("w");
      return job!;
    };
    const perm = await mk("perm.csv");
    drive.failWith(new m.d.DriveError(400, "badRequest", "bad", false));
    await expect(
      d.queue.process(perm, "2026-03-05", new TextEncoder().encode("perm.csv")),
    ).rejects.toThrow();
    expect(status(perm.id)?.status).toBe("blocked");

    const temp = await mk("temp.csv");
    drive.failWith(new m.d.DriveError(503, "backendError", "later", true));
    await expect(
      d.queue.process(temp, "2026-03-05", new TextEncoder().encode("temp.csv")),
    ).rejects.toThrow();
    expect(status(temp.id)?.status).toBe("failed");
    expect(status(temp.id)?.next).not.toBeNull();
  });
});
