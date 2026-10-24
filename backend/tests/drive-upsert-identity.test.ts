/**
 * Remediation Stage 2 — Task 2.5 (C-06): the Drive upsert, proven.
 *
 * Before this the "found → updateMedia" branch was never exercised: every test double returned
 * `null` from `findByAppKey`, so the suite was green while the feature's headline behaviour was
 * untested. The key was also derived from the FILE NAME, so renaming a party or cancelling an
 * invoice produced a NEW key → a NEW Drive file, and the old file stayed behind as an orphan.
 *
 * These tests drive the PRODUCTION archive pass against a real temporary SQLite database and a
 * stateful fake Drive that stores files by their `motardKey`, and assert the property the user
 * cares about: ONE Drive file per business document, whatever the document's fields become.
 */
import { describe, it, expect, beforeAll, beforeEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

process.env.DB_ENGINE = "sqlite";
process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "motard-upsert-")), "data", "motard.db");
process.env.MOTARD_STARTUP_STATE = "FRESH";
process.env.MOTARD_INSTALLATION_ID ??= randomUUID();
process.env.MOTARD_INSTALL_INSTANCE_ID ??= randomUUID();
process.env.MOTARD_DATA_ID ??= randomUUID();
delete process.env.DATABASE_URL;
delete process.env.DESKTOP_SEED_PATH;
const sandbox = mkdtempSync(join(tmpdir(), "motard-upsert-bk-"));
process.env.MOTARD_BACKUP_REGISTRY = join(sandbox, "backups.json");

let raw: import("better-sqlite3").Database;
let writerDb: unknown;
let job: typeof import("../src/infrastructure/googledrive/monthlyArchiveJob.js");
let fmod: typeof import("../src/infrastructure/googledrive/folderOrganizer.js");
let qmod: typeof import("../src/infrastructure/googledrive/uploadQueue.js");
let emod: typeof import("../src/infrastructure/googledrive/exporters.js");
let tenantId: string;
let partyId: string;
let invoiceId: string;

/**
 * A stateful fake Drive: files are stored by their `motardKey`, so the upsert can really be
 * observed. Every upload and every update is counted.
 */
class FakeDrive {
  files: Array<{ id: string; name: string; content: Uint8Array; appKey: string | null }> = [];
  uploads = 0;
  updates = 0;
  private folders = new Map<string, string>();
  private seq = 0;

  private decode(content: Uint8Array | string): string {
    return typeof content === "string" ? content : new TextDecoder().decode(content);
  }

  async findChild(parent: string, name: string) {
    const id = this.folders.get(`${parent}|${name}`);
    return id ? { id, name, mimeType: "folder" } : null;
  }
  async createFolder(parent: string | null, name: string) {
    const id = `fld-${this.folders.size + 1}`;
    this.folders.set(`${parent}|${name}`, id);
    return { id, name, mimeType: "folder" };
  }
  /** The upsert lookup: the file that carries this key, wherever it lives. */
  async findByAppKey(appKey: string) {
    const f = this.files.find((x) => x.appKey === appKey);
    return f ? { id: f.id, name: f.name, mimeType: "text/csv" } : null;
  }
  async updateMedia(fileId: string, _mime: string, content: Uint8Array, name?: string) {
    const f = this.files.find((x) => x.id === fileId);
    if (!f) throw new Error(`no such file ${fileId}`);
    this.updates++;
    f.content = content;
    if (name) f.name = name;
    return { id: f.id, name: f.name, mimeType: "text/csv" };
  }
  async updateAppProperties(fileId: string, appKey: string) {
    const f = this.files.find((x) => x.id === fileId);
    if (f) f.appKey = appKey;
    return { id: fileId, name: f?.name ?? "x", mimeType: "text/csv" };
  }
  async uploadSmall(
    _parent: string,
    name: string,
    _mime: string,
    content: Uint8Array,
    appKey?: string,
  ) {
    return this.create(name, content, appKey);
  }
  async uploadResumable(
    _parent: string,
    name: string,
    _mime: string,
    content: Uint8Array,
    appKey?: string,
  ) {
    return this.create(name, content, appKey);
  }
  async uploadResumableFromFile(
    _parent: string,
    name: string,
    _mime: string,
    _filePath: string,
    _size: number,
    appKey?: string,
  ) {
    return this.create(name, new Uint8Array(), appKey);
  }
  private create(name: string, content: Uint8Array, appKey?: string) {
    this.uploads++;
    const id = `file-${++this.seq}`;
    this.files.push({ id, name, content, appKey: appKey ?? null });
    return { id, name, mimeType: "text/csv" };
  }
  async getFile(id: string) {
    const f = this.files.find((x) => x.id === id);
    return f ? { id: f.id, name: f.name, mimeType: "text/csv" } : null;
  }
  /** The text of every stored file, for content assertions. */
  text(): string {
    return this.files.map((f) => this.decode(f.content)).join("\n---\n");
  }
  /** The file that holds the invoice (its name carries the invoice number). */
  invoiceFile() {
    return this.files.find((f) => f.name.includes("U-1"));
  }
}

function deps(drive: FakeDrive) {
  const db = writerDb as never;
  const folders = new fmod.FolderOrganizer(db, drive as never);
  const queue = new qmod.UploadQueue(db, drive as never, folders);
  const exporters = new emod.Exporters(db);
  return { db, queue, folders, exporters, drive: drive as never, localDeviceId: "dev-upsert" };
}

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

  tenantId = randomUUID();
  raw
    .prepare(`INSERT INTO tenants (id, name, slug) VALUES (?, 'upsert', 'upsert-test')`)
    .run(tenantId);
  raw.prepare(`INSERT INTO settings (id, tenant_id) VALUES (?, ?)`).run(randomUUID(), tenantId);
  raw
    .prepare(
      `INSERT INTO parties (id, tenant_id, kind, name, currency) VALUES (?, ?, 'customer', 'Alpha', 'SYP')`,
    )
    .run(randomUUID(), tenantId);
  partyId = (raw.prepare(`SELECT id FROM parties WHERE name = 'Alpha'`).get() as { id: string }).id;
  invoiceId = randomUUID();
  // Money is a scaled integer in SQLite (× 100), so 100.00 is stored as 10000.
  raw
    .prepare(
      `INSERT INTO invoices (id, tenant_id, number, type, date, party_id, party_type, subtotal, total, paid, status)
       VALUES (?, ?, 'U-1', 'sale', '2026-10-03', ?, 'customer', 10000, 10000, 0, 'active')`,
    )
    .run(invoiceId, tenantId, partyId);
  raw
    .prepare(`UPDATE settings SET drive = ?`)
    .run(JSON.stringify({ archiveEnabled: true, coordinatorDeviceId: "dev-upsert" }));
});

/** Each test starts from a clean queue and a clean document, so the fake Drive is the only state. */
beforeEach(() => {
  raw.prepare(`DELETE FROM motard_drive_uploads`).run();
  raw.prepare(`DELETE FROM motard_drive_folders`).run();
  raw.prepare(`UPDATE parties SET name = 'Alpha' WHERE id = ?`).run(partyId);
  raw
    .prepare(`UPDATE invoices SET total = 10000, subtotal = 10000, status = 'active' WHERE id = ?`)
    .run(invoiceId);
});

describe("the Drive upsert", () => {
  it("keeps ONE Drive file for a document whose total changes", async () => {
    const drive = new FakeDrive();
    const report = await job.runArchivePass(deps(drive), "manual");
    expect(report.skipped).toBeNull();
    expect(drive.uploads).toBeGreaterThan(0);
    expect(drive.files.length).toBe(1);
    expect(drive.text()).toContain("100");

    // Edit the invoice. The content changes; the document's identity does not.
    raw.prepare(`UPDATE invoices SET total = 25000, subtotal = 25000 WHERE id = ?`).run(invoiceId);
    await job.runArchivePass(deps(drive), "manual");

    // ONE file — the edit updated it in place instead of creating a second one.
    expect(drive.files.length).toBe(1);
    expect(drive.text()).toContain("250");
    expect(drive.updates).toBeGreaterThan(0);
  });

  it("keeps ONE Drive file when the party is renamed, and refreshes the file name", async () => {
    const drive = new FakeDrive();
    await job.runArchivePass(deps(drive), "manual");
    expect(drive.files.length).toBe(1);
    expect(drive.invoiceFile()!.name).toContain("Alpha");

    raw.prepare(`UPDATE parties SET name = 'Beta' WHERE id = ?`).run(partyId);
    await job.runArchivePass(deps(drive), "manual");

    expect(drive.files.length).toBe(1);
    expect(drive.invoiceFile()!.name).toContain("Beta");
    expect(drive.invoiceFile()!.name).not.toContain("Alpha");
  });

  it("keeps ONE Drive file when the invoice is cancelled, and refreshes the file name", async () => {
    const drive = new FakeDrive();
    await job.runArchivePass(deps(drive), "manual");
    expect(drive.files.length).toBe(1);

    raw.prepare(`UPDATE invoices SET status = 'cancelled' WHERE id = ?`).run(invoiceId);
    await job.runArchivePass(deps(drive), "manual");

    expect(drive.files.length).toBe(1);
    expect(drive.invoiceFile()!.name).toContain("ملغاة");
  });

  it("does not re-upload a document whose content did not change", async () => {
    const drive = new FakeDrive();
    await job.runArchivePass(deps(drive), "manual");
    const uploadsAfterFirst = drive.uploads;
    await job.runArchivePass(deps(drive), "manual");
    // Nothing changed: no new upload, no new file.
    expect(drive.uploads).toBe(uploadsAfterFirst);
    expect(drive.files.length).toBe(1);
  });

  it("does NO work on the second tick", async () => {
    const drive = new FakeDrive();
    const first = await job.runArchivePass(deps(drive), "manual");
    expect(first.skipped).toBeNull();
    expect(first.periods.length).toBeGreaterThan(0);
    const uploads = drive.uploads;

    // The scheduled tick after the manual one: every period that should be archived already is, so
    // the pass does no work at all — it does not re-export 24 months and re-hash them.
    const second = await job.runArchivePass(deps(drive), "timer");
    expect(second.skipped).toBe("NOTHING_TO_DO");
    expect(second.periods).toEqual([]);
    expect(drive.uploads).toBe(uploads);
  });

  it("keys the Drive file by the document's immutable id, not by its name", async () => {
    const drive = new FakeDrive();
    await job.runArchivePass(deps(drive), "manual");
    const invoiceFile = drive.invoiceFile();
    expect(invoiceFile).toBeDefined();
    // The key carries the tenant and the invoice UUID — never the file name, which changes on a
    // rename, a cancellation and a renumbering.
    expect(invoiceFile!.appKey).toContain(tenantId);
    expect(invoiceFile!.appKey).toContain(invoiceId);
    expect(invoiceFile!.appKey).not.toContain("Alpha");
  });

  it("adopts a file uploaded by 3.0.6 (no key on Drive) by its id — no second file", async () => {
    const drive = new FakeDrive();
    // What 3.0.6 left behind: a Drive file WITHOUT any appProperties, and a queue row that
    // remembers its id (no document id, no tenant, no uploaded hash).
    const old = {
      id: "file-306",
      name: "2026-10-03_U-1_Alpha.csv",
      content: new Uint8Array(),
      appKey: null,
    };
    drive.files.push(old);
    raw
      .prepare(
        `INSERT INTO motard_drive_uploads (id, stable_key, entity_type, entity_id, period_key, section,
           file_name, mime_type, content_sha256, content_bytes, status, device_id, drive_file_id,
           created_at, updated_at)
         VALUES (?, ?, 'invoice', ?, '2026-10', 'sale_invoices', ?, 'text/csv', ?, 1, 'done',
           'dev-upsert', 'file-306', ?, ?)`,
      )
      .run(
        randomUUID(),
        `legacy-${randomUUID()}`,
        old.name,
        old.name,
        "0".repeat(64),
        new Date().toISOString(),
        new Date().toISOString(),
      );

    await job.runArchivePass(deps(drive), "manual");

    // The same file, now carrying the key — no orphan beside it.
    expect(drive.files.filter((f) => f.name.includes("U-1"))).toHaveLength(1);
    expect(drive.uploads).toBe(0);
    expect(old.appKey).toContain(invoiceId);
  });

  it("matches a legacy file name literally (GLOB wildcards in a number are escaped)", () => {
    expect(qmod.globLiteral("2026-10-03_A?1[x]*_")).toBe("2026-10-03_A[?]1[[]x][*]_");
  });

  it("gives two installations sharing one Google account different keys", () => {
    // The key embeds the tenant, so a second installation cannot overwrite the first one's file.
    const job = {
      tenantId: "tenant-a",
      entityType: "invoice",
      entityId: "x",
      periodKey: "2026-10",
      section: "sale_invoices",
      documentId: "doc-1",
    };
    const keyA = qmod.documentKey(job as never);
    const keyB = qmod.documentKey({ ...job, tenantId: "tenant-b" } as never);
    expect(keyA).not.toBe(keyB);
    expect(keyA.startsWith("tenant-a|")).toBe(true);
    expect(keyB.startsWith("tenant-b|")).toBe(true);
  });

  it("keeps the legacy key for a row written before the upgrade", () => {
    // A row from before migration 0008 has no document id: it keeps the file-name-derived key for
    // what it uploads now. (Files uploaded BY 3.0.6 carry no key at all; they are adopted by their
    // id — see "adopts a file uploaded by 3.0.6" above.)
    const legacy = qmod.legacyDocumentKey({
      entityType: "invoice",
      entityId: "2026-10-03_U-1_Alpha.csv",
      periodKey: "2026-10",
      section: "sale_invoices",
    } as never);
    expect(legacy).toContain("archive|");
    expect(legacy).toContain("2026-10-03_U-1_Alpha.csv");
    const current = qmod.documentKey({
      tenantId: "t",
      entityType: "invoice",
      entityId: "2026-10-03_U-1_Alpha.csv",
      periodKey: "2026-10",
      section: "sale_invoices",
      documentId: null,
    } as never);
    expect(current).toBe(legacy);
  });
});
