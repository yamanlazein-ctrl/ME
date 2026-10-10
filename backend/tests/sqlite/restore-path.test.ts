/**
 * Restore hand-off regression (the "restore always fails with ملف غير صالح" bug).
 *
 * ROOT CAUSE this pins: the desktop SPA reaches the API over the Tauri IPC bridge, whose request body
 * is a `String`. A `File` cannot cross it, so an octet-stream upload arrived as ZERO bytes and the
 * server answered "لم يصل أي ملف" for a perfectly valid v3 archive. The fix hands the archive over as a
 * PATH (`/api/backup/verify-path`, `/api/backup/restore-path`), with the shell's own size + sha256
 * re-verified here from the file's bytes.
 *
 * Every case below runs against a REAL v3 archive produced by `createAndVerifyBackup` on an isolated
 * temporary data root, and the destructive ones use a throwaway copy — never the operator's file and
 * never the live database of anything but this test's own temp root.
 *
 * Covered: a valid archive restoring successfully · the supported archive layout · missing/malformed
 * manifest and database · wrong SHA-256 and genuinely corrupt archives · an older app version restored
 * by a newer one · a missing file / failed transfer · distinct Arabic messages per case · and a failed
 * restore leaving the existing database byte-identical.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, copyFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";

const root = mkdtempSync(join(tmpdir(), "motard-rsr-"));
const archives = mkdtempSync(join(tmpdir(), "motard-rsr-arch-"));
process.env.DB_ENGINE = "sqlite";
process.env.SQLITE_PATH = join(root, "data", "motard.db");
process.env.MOTARD_STARTUP_STATE = "FRESH";
// Restore is a DESKTOP-only endpoint (`config.DESKTOP_DEPLOY`); the desktop suites run with it on.
// Must be set before anything imports `infrastructure/config/env.js`, which parses it once.
// With DESKTOP_DEPLOY the SQLite runtime also requires an installation id on FRESH boot (runtime.ts
// `requireInstallationId: config.DESKTOP_DEPLOY`).
process.env.DESKTOP_DEPLOY = "true";
process.env.MOTARD_INSTALLATION_ID = "00000000-0000-4000-8000-000000000001";
delete process.env.DATABASE_URL;
delete process.env.DESKTOP_SEED_PATH;
const TENANT = randomUUID();
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

let server: Server;
let base = "";
let role = "admin";
type Runtime = typeof import("@/infrastructure/orm/sqlite/runtime.js");
let runtime: Runtime;
type Backup = typeof import("@/infrastructure/backup/sqliteBackup.js");
let backup: Backup;

/** The operator's own archive — the test copy. The original is never opened for writing. */
const original = join(archives, "MotardERP-Backup-2026-10-07.zip");

function writer(): import("better-sqlite3").Database {
  return runtime.getSqliteRuntime()!.conns.writer as unknown as import("better-sqlite3").Database;
}

/** A working copy of a file, so a test can corrupt it without touching the source. */
function copy(name: string, from = original): string {
  const dst = join(archives, name);
  copyFileSync(from, dst);
  return dst;
}

function entries(file: string): Record<string, Uint8Array> {
  return unzipSync(new Uint8Array(readFileSync(file)));
}

function writeZip(name: string, e: Record<string, Uint8Array>): string {
  const dst = join(archives, name);
  writeFileSync(dst, zipSync(e));
  return dst;
}

type ErrBody = { code?: string; message?: string };

async function verifyPath(path: string, extra: { sha256?: string; sizeBytes?: number } = {}) {
  const r = await fetch(`${base}/api/backup/verify-path`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, ...extra }),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as ErrBody & Record<string, unknown> };
}

async function restorePath(path: string, extra: { sha256?: string; sizeBytes?: number } = {}) {
  const r = await fetch(`${base}/api/backup/restore-path?confirm=replace`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
    body: JSON.stringify({ path, ...extra }),
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as ErrBody & Record<string, unknown> };
}

/** An octet-stream upload with NO body — exactly what the buggy bridge produced. */
async function restoreEmptyUpload() {
  const r = await fetch(`${base}/api/backup/restore?confirm=replace`, {
    method: "POST",
    headers: { "Content-Type": "application/octet-stream", Authorization: "Bearer test" },
  });
  return { status: r.status, body: (await r.json().catch(() => ({}))) as ErrBody };
}

beforeAll(async () => {
  runtime = await import("@/infrastructure/orm/sqlite/runtime.js");
  backup = await import("@/infrastructure/backup/sqliteBackup.js");
  await runtime.ensureSqliteRuntime();
  writer().prepare(`INSERT INTO tenants (id, name, slug) VALUES (?, 'شركة الاستعادة', 'rsr')`).run(TENANT);
  const { createBackupRouter } = await import("@/presentation/routes/backup.route.js");
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { tenantContext: unknown }).tenantContext = { tenantId: TENANT, userRole: role, userId: randomUUID() };
    next();
  });
  app.use("/api", createBackupRouter({} as never));
  server = await new Promise<Server>((res) => {
    const s = app.listen(0, "127.0.0.1", () => res(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  // A REAL, VERIFIED v3 archive from this data root — the "operator's backup" these tests copy.
  const created = await backup.createAndVerifyBackup({ kind: "manual", appVersion: "2.0.2" });
  copyFileSync(created.path, original);
}, 180_000);

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  runtime?.shutdownSqliteRuntime();
  rmSync(root, { recursive: true, force: true });
  rmSync(archives, { recursive: true, force: true });
});

describe("the archive layout the desktop restore accepts", () => {
  it("has manifest.json + manifest.sha256 + database.sqlite at the archive ROOT, format v3", async () => {
    const e = entries(original);
    expect(Object.keys(e).sort()).toEqual(["database.sqlite", "manifest.json", "manifest.sha256"]);
    const man = JSON.parse(strFromU8(e["manifest.json"])) as { format: string; formatVersion: number; app: { version: string } };
    expect(man.format).toBe("motard-erp-backup");
    expect(man.formatVersion).toBe(3);
    expect(man.app.version).toBe("2.0.2");
    // and manifest.sha256 really is the digest of manifest.json's bytes
    expect(strFromU8(e["manifest.sha256"]).trim()).toBe(sha(e["manifest.json"]));
  });
});

describe("a valid v3 archive restores through the by-path endpoint", () => {
  it("verifies, reports the company and its row counts, and leaves the archive untouched", async () => {
    const before = sha(readFileSync(original));
    const r = await verifyPath(original);
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
    expect(r.body.formatVersion).toBe(3);
    expect(r.body.appVersion).toBe("2.0.2");
    expect(r.body.company).toBe("شركة الاستعادة");
    expect(typeof r.body.rows).toBe("number");
    // RS-3: the archive is only ever read.
    expect(sha(readFileSync(original))).toBe(before);
  });

  it("restores successfully and the live database ends up carrying the archive's data", async () => {
    const before = sha(readFileSync(original));
    const r = await restorePath(original);
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.manifest).toBeTruthy();
    expect(r.body.safetyBackup, "a VERIFIED safety backup of the replaced data is taken first").toBeTruthy();
    // The restored company is now the live one.
    const live = writer().prepare("SELECT name FROM tenants WHERE id = ?").pluck().get(TENANT);
    expect(live).toBe("شركة الاستعادة");
    expect(sha(readFileSync(original)), "the operator's archive is never modified").toBe(before);
  }, 180_000);

  it("accepts the archive when the shell reports its own size and sha256 (the real desktop call)", async () => {
    const r = await verifyPath(original, {
      sha256: sha(readFileSync(original)),
      sizeBytes: readFileSync(original).length,
    });
    expect(r.status).toBe(200);
    expect(r.body.ok).toBe(true);
  });
});

describe("a missing file or a failed transfer is reported as such, not as a corrupt archive", () => {
  it("404s when the chosen file is gone", async () => {
    const r = await verifyPath(join(archives, "never-existed.zip"));
    expect(r.status).toBe(404);
    expect(r.body.code).toBe("BACKUP_FILE_MISSING");
    expect(r.body.message).toMatch(/غير موجود/);
  });

  it("refuses a request with no path at all", async () => {
    const res = await fetch(`${base}/api/backup/verify-path`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const b = (await res.json()) as ErrBody;
    expect(b.code).toBe("BACKUP_CORRUPT");
    expect(b.message).toMatch(/لم يُحدَّد مسار/);
  });

  it("refuses a shell-reported sha256 that does not match the file (substituted after picking)", async () => {
    const r = await verifyPath(original, { sha256: sha("a different file") });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("BACKUP_FILE_HASH_MISMATCH");
    expect(r.body.message).toMatch(/لا تطابق/);
  });

  it("refuses a shell-reported size that does not match the file", async () => {
    const r = await verifyPath(original, { sizeBytes: readFileSync(original).length + 1 });
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("BACKUP_FILE_HASH_MISMATCH");
  });

  it("a zero-byte upload (what the text-only bridge produced) is a TRANSFER failure, not 'invalid file'", async () => {
    const r = await restoreEmptyUpload();
    expect(r.status).toBe(400);
    expect(r.body.code).toBe("BACKUP_NO_FILE_RECEIVED");
    expect(r.body.message).toMatch(/لم يصل أي ملف/);
    expect(r.body.message).not.toMatch(/غير صالح/);
  });
});

describe("malformed and genuinely corrupt archives are each named distinctly", () => {
  it("a missing manifest.json says so", async () => {
    const e = entries(copy("no-manifest.zip"));
    delete e["manifest.json"];
    const r = await verifyPath(writeZip("no-manifest.zip", e));
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("BACKUP_MANIFEST_MISSING");
    expect(r.body.message).toMatch(/manifest\.json/);
  });

  it("a malformed manifest says so", async () => {
    const e = entries(copy("bad-manifest.zip"));
    e["manifest.json"] = strToU8("{ not json");
    const r = await verifyPath(writeZip("bad-manifest.zip", e));
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("BACKUP_MANIFEST_MISSING");
    expect(r.body.message).toMatch(/manifest\.json/);
  });

  it("a wrong manifest SHA-256 is a checksum failure", async () => {
    const e = entries(copy("bad-hash.zip"));
    e["manifest.sha256"] = strToU8(sha("something else"));
    const r = await verifyPath(writeZip("bad-hash.zip", e));
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("BACKUP_MANIFEST_HASH_MISMATCH");
    expect(r.body.message).toMatch(/بصمة/);
  });

  it("a missing database.sqlite says so", async () => {
    const e = entries(copy("no-db.zip"));
    delete e["database.sqlite"];
    const r = await verifyPath(writeZip("no-db.zip", e));
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("BACKUP_DATABASE_MISSING");
    expect(r.body.message).toMatch(/database\.sqlite/);
  });

  it("a file that is not a ZIP at all says so", async () => {
    const notZip = join(archives, "not-a-zip.zip");
    writeFileSync(notZip, "this is not a zip archive");
    const r = await verifyPath(notZip);
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("BACKUP_NOT_A_ZIP");
    expect(r.body.message).toMatch(/ZIP/);
  });

  it("a genuinely corrupted database inside a well-formed archive is an integrity/checksum failure", async () => {
    const e = entries(copy("corrupt-db.zip"));
    // Flip bytes inside database.sqlite and re-zip: the archive structure is intact (what a truncated
    // download plus a re-pack looks like) but the stored content no longer hashes to the manifest.
    const db = new Uint8Array(e["database.sqlite"]);
    for (let i = 4096; i < 8192; i++) db[i] = db[i]! ^ 0xff;
    e["database.sqlite"] = db;
    const r = await verifyPath(writeZip("corrupt-db.zip", e));
    expect(r.status).toBe(422);
    expect(["BACKUP_TABLE_MISMATCH", "BACKUP_INTEGRITY_FAILED", "BACKUP_NOT_A_ZIP"]).toContain(r.body.code);
    expect(r.body.message).not.toBe("ملف غير صالح");
  });
});

describe("version compatibility", () => {
  it("an older-version backup (2.0.2) is accepted by the newer app and migrated forward", async () => {
    // The archive declares app 2.0.2 while this tree is 2.0.4 — the exact reported scenario.
    const r = await restorePath(copy("older-version.zip"));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.manifest).toBeTruthy();
  }, 180_000);

  it("a NEWER app.version alone is NOT refused — only a newer archive FORMAT or SCHEMA is", async () => {
    // `app.version` is recorded for the operator, not a gate: the contract gates on `formatVersion`
    // (>3 = newer archive format) and `schema.journalIdx` (newer migrations). A newer-but-compatible
    // app therefore still restores, and an older one is refused only when it cannot apply the schema.
    const e = entries(copy("newer-appversion.zip"));
    const man = JSON.parse(strFromU8(e["manifest.json"])) as Record<string, unknown>;
    (man.app as Record<string, unknown>).version = "99.0.0";
    e["manifest.json"] = strToU8(JSON.stringify(man));
    e["manifest.sha256"] = strToU8(sha(e["manifest.json"]));
    const r = await verifyPath(writeZip("newer-appversion.zip", e));
    expect(r.status, JSON.stringify(r.body)).toBe(200);
    expect(r.body.appVersion).toBe("99.0.0");
  });

  it("a backup with a NEWER archive format (4) is refused with an actionable message", async () => {
    const e = entries(copy("newer-format.zip"));
    const man = JSON.parse(strFromU8(e["manifest.json"])) as Record<string, unknown>;
    man.formatVersion = 4;
    e["manifest.json"] = strToU8(JSON.stringify(man));
    e["manifest.sha256"] = strToU8(sha(e["manifest.json"]));
    const r = await verifyPath(writeZip("newer-format.zip", e));
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("BACKUP_NEWER_THAN_APP");
    expect(r.body.message).toMatch(/أحدث من البرنامج|حدّث البرنامج/);
  });

  it("a backup whose schema is NEWER than this app is refused, telling the operator to update", async () => {
    const e = entries(copy("newer-schema.zip"));
    const man = JSON.parse(strFromU8(e["manifest.json"])) as { schema: { journalIdx: number } };
    man.schema.journalIdx = 9999;
    e["manifest.json"] = strToU8(JSON.stringify(man));
    e["manifest.sha256"] = strToU8(sha(e["manifest.json"]));
    const r = await verifyPath(writeZip("newer-schema.zip", e));
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("BACKUP_NEWER_THAN_APP");
    expect(r.body.message).toMatch(/ترحيلات أحدث|حدّث البرنامج/);
  });

  it("a PostgreSQL-era (v2) archive is refused with its own message", async () => {
    const e = entries(copy("v2-era.zip"));
    const man = JSON.parse(strFromU8(e["manifest.json"])) as Record<string, unknown>;
    man.formatVersion = 2;
    e["manifest.json"] = strToU8(JSON.stringify(man));
    e["manifest.sha256"] = strToU8(sha(e["manifest.json"]));
    const r = await verifyPath(writeZip("v2-era.zip", e));
    expect(r.status).toBe(422);
    expect(r.body.code).toBe("BACKUP_UNSUPPORTED_FORMAT");
    expect(r.body.message).toMatch(/PostgreSQL/);
  });
});

describe("a failed restore leaves the existing database unchanged", () => {
  it("the live file is byte-identical after a corrupt archive is refused", async () => {
    const liveImage = () =>
      ["", "-wal", "-shm"]
        .map((x) => `${process.env.SQLITE_PATH}${x}`)
        .filter(existsSync)
        .sort()
        .map((p) => sha(readFileSync(p)))
        .join("|");
    const before = liveImage();
    const e = entries(copy("refused.zip"));
    delete e["manifest.json"];
    const r = await restorePath(writeZip("refused.zip", e));
    expect(r.status).toBe(422);
    expect(r.body.message).toMatch(/لم تتغير البيانات الحالية|manifest/);
    expect(liveImage()).toBe(before);
    expect(runtime.getSqliteRuntime(), "the live database stays open").toBeTruthy();
  }, 180_000);
});
