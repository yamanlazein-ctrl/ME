/**
 * The database-backup upload path (`processFile`) verifies the CONTENT Drive stored, not just that a
 * file exists. The backup is the copy a lost installation is recovered from, so a truncated or
 * corrupted upload must never be recorded as `done`.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomBytes, randomUUID } from "node:crypto";

process.env.DB_ENGINE = "sqlite";
process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "motard-bkv-")), "data", "motard.db");
process.env.MOTARD_STARTUP_STATE = "FRESH";
process.env.MOTARD_INSTALLATION_ID ??= randomUUID();
process.env.MOTARD_INSTALL_INSTANCE_ID ??= randomUUID();
process.env.MOTARD_DATA_ID ??= randomUUID();
delete process.env.DATABASE_URL;
delete process.env.DESKTOP_SEED_PATH;

type Queue = import("../src/infrastructure/googledrive/uploadQueue.js").UploadQueue;
let queue: Queue;
let raw: import("better-sqlite3").Database;
/** The md5 the fake Drive reports for the uploaded file; null = report what was actually sent. */
let reportedMd5: string | null = null;
let sentMd5 = "";
const dir = mkdtempSync(join(tmpdir(), "motard-bkv-files-"));

beforeAll(async () => {
  const { ensureSqliteRuntime, getSqliteRuntime } =
    await import("../src/infrastructure/orm/sqlite/runtime.js");
  await ensureSqliteRuntime({});
  const rt = getSqliteRuntime()!;
  raw = rt.conns.writer;
  const { UploadQueue } = await import("../src/infrastructure/googledrive/uploadQueue.js");
  const { FolderOrganizer } = await import("../src/infrastructure/googledrive/folderOrganizer.js");
  let n = 0;
  const drive = {
    async findChild() {
      return null;
    },
    async createFolder(_p: string | null, name: string) {
      return { id: `fld-${++n}`, name, mimeType: "application/vnd.google-apps.folder" };
    },
    async findByAppKey() {
      return null;
    },
    async uploadResumableFromFile(_parent: string, name: string, _mime: string, filePath: string) {
      const { readFileSync } = await import("node:fs");
      sentMd5 = createHash("md5").update(readFileSync(filePath)).digest("hex");
      return { id: `bk-${++n}`, name, mimeType: "application/zip" };
    },
    async getFile(fileId: string) {
      if (!fileId.startsWith("bk-")) return null;
      return {
        id: fileId,
        name: "backup.zip",
        mimeType: "application/zip",
        md5Checksum: reportedMd5 ?? sentMd5,
      };
    },
  };
  const folders = new FolderOrganizer(rt.conns.writerDb as never, drive as never);
  queue = new UploadQueue(rt.conns.writerDb as never, drive as never, folders);
});

async function uploadBackup(name: string) {
  const content = randomBytes(64 * 1024);
  const filePath = join(dir, name);
  writeFileSync(filePath, content);
  await queue.enqueueFile({
    entityType: "db_backup",
    entityId: filePath,
    documentId: name,
    tenantId: randomUUID(),
    businessDate: "2026-10-21",
    section: "dbBackups",
    fileName: name,
    mimeType: "application/zip",
    deviceId: "device-a",
    filePath,
  });
  const job = await queue.claim("device-a");
  expect(job).not.toBeNull();
  const outcome = await queue
    .processFile(job!, "2026-10-21", filePath, content.length)
    .then(() => "done" as const)
    .catch((e: Error) => e.message);
  const row = raw.prepare(`SELECT status FROM motard_drive_uploads WHERE id = ?`).get(job!.id) as {
    status: string;
  };
  return { outcome, status: row.status };
}

describe("database backup upload — content verification", () => {
  it("records the backup as done when Drive holds exactly the bytes sent", async () => {
    reportedMd5 = null;
    const r = await uploadBackup("backup-ok.zip");
    expect(r.outcome).toBe("done");
    expect(r.status).toBe("done");
  });

  it("refuses to record a backup whose stored content does not match", async () => {
    reportedMd5 = "0".repeat(32);
    const r = await uploadBackup("backup-truncated.zip");
    expect(r.outcome).toContain("the stored content does not match");
    expect(r.status).not.toBe("done");
  });
});
