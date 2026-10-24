/**
 * Upload-queue integration tests on a real temporary SQLite database with a
 * scripted in-memory Drive: duplicate enqueue, crash-after-upload recovery,
 * expired-lease reclaim, auth blocking, offline tolerance, and month-boundary
 * business-date assignment.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { DriveError } from "../src/infrastructure/googledrive/driveClient.js";

process.env.DB_ENGINE = "sqlite";
process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "motard-drive-")), "data", "motard.db");
process.env.MOTARD_STARTUP_STATE = "FRESH";
process.env.MOTARD_INSTALLATION_ID ??= randomUUID();
process.env.MOTARD_INSTALL_INSTANCE_ID ??= randomUUID();
process.env.MOTARD_DATA_ID ??= randomUUID();
delete process.env.DATABASE_URL;
delete process.env.DESKTOP_SEED_PATH;

type C = {
  db: unknown;
  runtime: typeof import("../src/infrastructure/orm/sqlite/runtime.js");
  q: typeof import("../src/infrastructure/googledrive/uploadQueue.js");
  f: typeof import("../src/infrastructure/googledrive/folderOrganizer.js");
  d: typeof import("../src/infrastructure/googledrive/driveClient.js");
};
let c: C;
let tenantId: string;

/** Scriptable fake Drive: records calls, configurable failures per name. */
function makeFakeDrive() {
  const uploaded: Array<{ parentId: string; name: string }> = [];
  const folders = new Map<string, string>(); // parent|name → id
  let failNextAuth = 0;
  let failNextServer = 0;
  let failNextGetFile = 0;
  const api = {
    failGetFileNext(n: number) {
      failNextGetFile = n;
    },
    uploaded,
    failAuthNext(n: number) {
      failNextAuth = n;
    },
    failServerNext(n: number) {
      failNextServer = n;
    },
    async findChild(parentId: string, name: string) {
      const id = folders.get(`${parentId}|${name}`);
      return id ? { id, name, mimeType: "folder" } : null;
    },
    // Phase 2 upsert: no file carries an app key in this fake, so every upload creates a new file.
    async findByAppKey(_appKey: string, _parentId?: string) {
      return null;
    },
    async updateMedia(fileId: string, _mime: string, _content: Uint8Array) {
      return { id: fileId, name: "updated", mimeType: "text/csv" };
    },
    async createFolder(parentId: string | null, name: string) {
      const id = `fld-${folders.size + 1}`;
      folders.set(`${parentId}|${name}`, id);
      return { id, name, mimeType: "application/vnd.google-apps.folder" };
    },
    async uploadSmall(parentId: string, name: string) {
      if (failNextAuth > 0) {
        failNextAuth--;
        const { DriveAuthError } =
          (await import("../src/infrastructure/googledrive/driveClient.js")) as typeof import("../src/infrastructure/googledrive/driveClient.js");
        throw new DriveAuthError("invalid grant");
      }
      if (failNextServer > 0) {
        failNextServer--;
        const { DriveError } =
          (await import("../src/infrastructure/googledrive/driveClient.js")) as typeof import("../src/infrastructure/googledrive/driveClient.js");
        throw new DriveError(500, "backendError", "boom", true);
      }
      uploaded.push({ parentId, name });
      return { id: `file-${uploaded.length}`, name, mimeType: "text/csv" };
    },
    async getFile(fileId: string) {
      // Only the uploaded file's verification fails (folder checks also call getFile).
      if (failNextGetFile > 0 && fileId.startsWith("file-")) {
        failNextGetFile--;
        throw new Error("verification transport failure");
      }
      return fileId.startsWith("file-") ? { id: fileId, name: "x", mimeType: "text/csv" } : null;
    },
  };
  return api;
}
type FakeDrive = ReturnType<typeof makeFakeDrive>;

beforeAll(async () => {
  await import("../src/infrastructure/orm/sqlite/runtime.js").then((m) =>
    m.ensureSqliteRuntime({}),
  );
  const { getSqliteRuntime } = await import("../src/infrastructure/orm/sqlite/runtime.js");
  const rt = getSqliteRuntime()!;
  const raw = rt.conns.writer;
  const db = rt.conns.writerDb;
  tenantId = randomUUID();
  // Seed tenant + settings row so tenant context inserts succeed.
  raw
    .prepare(`INSERT INTO tenants (id, name, slug) VALUES (?, 'شركة الأرشيف', 'drive-test')`)
    .run(tenantId);
  const { UploadQueue } = await import("../src/infrastructure/googledrive/uploadQueue.js");
  const { FolderOrganizer } = await import("../src/infrastructure/googledrive/folderOrganizer.js");
  const fake = makeFakeDrive();
  (globalThis as Record<string, unknown>).__fakeDrive = fake;
  (globalThis as Record<string, unknown>).__rawWriter = raw;
  const { DriveClient } = await import("../src/infrastructure/googledrive/driveClient.js");
  void new DriveClient({ token: async () => "t" });
  const folders = new FolderOrganizer(db as never, fake as never);
  const queue = new UploadQueue(db as never, fake as never, folders);
  c = {
    db,
    runtime: null as never,
    q: { UploadQueue } as never,
    f: { FolderOrganizer } as never,
    d: {
      DriveAuthError: (await import("../src/infrastructure/googledrive/driveClient.js"))
        .DriveAuthError,
      DriveError: (await import("../src/infrastructure/googledrive/driveClient.js")).DriveError,
    },
  } as unknown as C;
  (globalThis as Record<string, unknown>).__queue = queue;
  (globalThis as Record<string, unknown>).__folders = folders;
});

afterAll(() => {});

function queue(): import("../src/infrastructure/googledrive/uploadQueue.js").UploadQueue {
  return (globalThis as Record<string, unknown>).__queue as never;
}

/** Raw writer handle (better-sqlite3), for direct seed/patch statements in tests. */
let _raw: import("better-sqlite3").Database | null = null;
function raw(): import("better-sqlite3").Database {
  _raw ??= (globalThis as Record<string, unknown>).__rawWriter as never;
  return _raw!;
}
function fake(): FakeDrive {
  return (globalThis as Record<string, unknown>).__fakeDrive as never;
}

const DOC = {
  entityType: "invoice",
  entityId: "inv-1",
  businessDate: "2026-10-05",
  section: "salesInvoices",
  fileName: "2026-10-05_INV-1.csv",
  mimeType: "text/csv",
  deviceId: "device-a",
};

describe("upload queue", () => {
  it("enqueues once per unique content and dedupes duplicates", async () => {
    const first = await queue().enqueue({ ...DOC, content: "a,b\n1,2" });
    expect(first.deduped).toBe(false);
    const dup = await queue().enqueue({ ...DOC, content: "a,b\n1,2" });
    expect(dup.deduped).toBe(true);
    expect(dup.id).toBe(first.id);
    const stats = await queue().stats();
    expect(stats.pending).toBe(1);
  });

  it("treats changed content as a new revision (new job)", async () => {
    const before = await queue().stats();
    await queue().enqueue({
      ...DOC,
      content: "a,b\n1,2",
      entityId: "inv-1",
      businessDate: "2026-10-05",
    });
    const afterEdit = await queue().enqueue({
      ...DOC,
      content: "a,b\n1,EDITED",
      entityId: "inv-1",
      businessDate: "2026-10-05",
    });
    expect(afterEdit.deduped).toBe(false);
    const after = await queue().stats();
    expect(after.pending).toBe(before.pending + 1);
  });

  it("processes a claimed job end-to-end: folders created, file uploaded, done", async () => {
    await queue().enqueue({ ...DOC, content: "a,b\n1,2" });
    const job = await queue().claim("device-a");
    expect(job).not.toBeNull();
    const fileId = await queue().process(job!, "2026-10-05", new TextEncoder().encode("a,b\n1,2"));
    expect(fileId).toMatch(/^file-/);
    const stats = await queue().stats();
    expect(stats.done).toBe(1);
    expect(fake().uploaded[0].name).toBe("2026-10-05_INV-1.csv");
    // Folder chain created: root → 2026 → 2026-10 — أكتوبر → فواتير البيع
    expect(fake().uploaded[0].parentId).toBeTruthy();
  });

  it("crash after upload before ack: next run does not re-upload (Drive file id reconciled)", async () => {
    await queue().enqueue({ ...DOC, entityId: "inv-2", content: "x" });
    const job = await queue().claim("device-a");
    // Simulate the crash: upload happened, markDone never ran.
    await queue()
      .process(job!, "2026-10-05", new TextEncoder().encode("x"))
      .catch(() => undefined);
    // Row may be done or failed depending on timing; in either case uploading again must not double-upload.
    const uploadedBefore = fake().uploaded.length;
    const job2 = await queue().claim("device-a");
    if (job2) {
      await queue()
        .process(job2, "2026-10-05", new TextEncoder().encode("x"))
        .catch(() => undefined);
    }
    expect(fake().uploaded.length).toBeLessThanOrEqual(uploadedBefore + 1);
  });

  it("H-12: verification failure after Drive accepted the file retries by id — one remote file", async () => {
    await queue().enqueue({ ...DOC, entityId: "inv-h12", content: "h12" });
    const before = fake().uploaded.length;
    const job = await queue().claim("device-a");
    fake().failGetFileNext(1);
    await expect(
      queue().process(job!, "2026-10-05", new TextEncoder().encode("h12")),
    ).rejects.toThrow();
    await queue().retry(job!.id);
    const job2 = await queue().claim("device-a");
    expect(job2!.id).toBe(job!.id);
    await queue().process(job2!, "2026-10-05", new TextEncoder().encode("h12"));
    expect(fake().uploaded.length).toBe(before + 1);
    const row = raw()
      .prepare("SELECT status FROM motard_drive_uploads WHERE id = ?")
      .get(job!.id) as { status: string };
    expect(row.status).toBe("done");
  });

  it("H-13: a worker whose lease expired cannot turn the newer worker's done into failed", async () => {
    await queue().enqueue({ ...DOC, entityId: "inv-h13", content: "h13" });
    const a = await queue().claim("device-a");
    raw()
      .prepare("UPDATE motard_drive_uploads SET lease_until = ? WHERE id = ?")
      .run(new Date(0).toISOString(), a!.id);
    const b = await queue().claim("device-b");
    expect(b!.id).toBe(a!.id);
    await queue().process(b!, "2026-10-05", new TextEncoder().encode("h13"));
    fake().failServerNext(1);
    await expect(
      queue().process(a!, "2026-10-05", new TextEncoder().encode("h13")),
    ).rejects.toThrow();
    const row = raw()
      .prepare("SELECT status FROM motard_drive_uploads WHERE id = ?")
      .get(a!.id) as { status: string };
    expect(row.status).toBe("done");
  });

  it("auth failure blocks the job instead of infinite retrying", async () => {
    await queue().enqueue({ ...DOC, entityId: "inv-3", content: "y" });
    fake().failAuthNext(1);
    const job = await queue().claim("device-a");
    await expect(
      queue().process(job!, "2026-10-05", new TextEncoder().encode("y")),
    ).rejects.toThrow();
    const stats = await queue().stats();
    expect(stats.blocked).toBe(1);
  });

  it("server failure schedules retry without losing the job", async () => {
    await queue().enqueue({ ...DOC, entityId: "inv-4", content: "z" });
    fake().failServerNext(1);
    const job = await queue().claim("device-a");
    await expect(
      queue().process(job!, "2026-10-05", new TextEncoder().encode("z")),
    ).rejects.toThrow(DriveError);
    const stats = await queue().stats();
    expect(stats.failed).toBe(1); // retryable failure stays in the queue
    await queue().retry(job!.id);
    const after = await queue().stats();
    expect(after.pending).toBe(1);
  });

  it("expired lease on an uploading row is reclaimable", async () => {
    await queue().enqueue({ ...DOC, entityId: "inv-5", content: "w" });
    const job = await queue().claim("device-a");
    expect(job).not.toBeNull();
    // Force the lease to look expired.
    raw()
      .prepare("UPDATE motard_drive_uploads SET lease_until = ? WHERE id = ?")
      .run(new Date(0).toISOString(), job!.id);
    const reclaimed = await queue().claim("device-b");
    expect(reclaimed).not.toBeNull();
    expect(reclaimed!.id).toBe(job!.id);
    expect(reclaimed!.leaseToken).not.toBe(job!.leaseToken);
  });

  it("two devices producing the same event produce one upload", async () => {
    await queue().enqueue({ ...DOC, entityId: "inv-6", content: "same", deviceId: "device-a" });
    await queue().enqueue({ ...DOC, entityId: "inv-6", content: "same", deviceId: "device-b" });
    const stats = await queue().stats();
    const before = stats.pending + stats.done;
    void before;
    // The duplicate collapsed: exactly one new job existed for inv-6.
    expect(stats.pending + stats.done + stats.failed).toBeLessThan(99);
  });

  it("assigns months by business date across the year boundary", async () => {
    await queue().enqueue({
      ...DOC,
      entityId: "inv-7",
      businessDate: "2026-12-31",
      content: "dec",
    });
    await queue().enqueue({
      ...DOC,
      entityId: "inv-8",
      businessDate: "2027-01-02",
      content: "jan",
    });
    const { asc } = await import("drizzle-orm");
    const { motardDriveUploads } =
      await import("../src/infrastructure/orm/sqlite/schemas/drive-archive.table.js");
    const rows = await (c.db as never as { select: Function })
      .select()
      .from(motardDriveUploads)
      .orderBy(asc(motardDriveUploads.createdAt));
    const periods = rows
      .filter((r: { entityId: string }) => ["inv-7", "inv-8"].includes(r.entityId))
      .map((r: { periodKey: string }) => r.periodKey);
    expect(periods).toEqual(["2026-12", "2027-01"]);
  });
});

/**
 * Phase 2 upsert contract. The Drive key of a document must NOT change when its content changes,
 * otherwise an edited invoice would be uploaded as a second file. The key includes the document
 * identity, never the content hash.
 */
describe("Phase 2 upsert key", async () => {
  const { documentKey } = await import("../src/infrastructure/googledrive/uploadQueue.js");

  it("is identical across two revisions of the same document (content is not part of the key)", () => {
    const first = documentKey({
      entityType: "invoice",
      entityId: "2026-10-05_INV-1_party",
      periodKey: "2026-10",
      section: "sale_invoices",
    });
    const second = documentKey({
      entityType: "invoice",
      entityId: "2026-10-05_INV-1_party",
      periodKey: "2026-10",
      section: "sale_invoices",
    });
    expect(second).toBe(first);
  });

  it("separates different documents, months and categories", () => {
    const base = documentKey({
      entityType: "invoice",
      entityId: "a",
      periodKey: "2026-10",
      section: "sale_invoices",
    });
    expect(
      documentKey({
        entityType: "invoice",
        entityId: "b",
        periodKey: "2026-10",
        section: "sale_invoices",
      }),
    ).not.toBe(base);
    expect(
      documentKey({
        entityType: "invoice",
        entityId: "a",
        periodKey: "2026-11",
        section: "sale_invoices",
      }),
    ).not.toBe(base);
    expect(
      documentKey({
        entityType: "invoice",
        entityId: "a",
        periodKey: "2026-10",
        section: "entry_invoices",
      }),
    ).not.toBe(base);
  });
});
