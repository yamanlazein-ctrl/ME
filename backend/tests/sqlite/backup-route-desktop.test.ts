/**
 * T100 (specs/001-desktop-sqlite-engine, I-11): on the SQLite desktop the full backup can be delivered
 * as METADATA (the bridge to the window is text-only), and the registry is readable for the
 * VERIFIED / FAILED status. The streamed zip path stays available for the web.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";

const root = mkdtempSync(join(tmpdir(), "motard-brd-"));
process.env.DB_ENGINE = "sqlite";
process.env.SQLITE_PATH = join(root, "data", "motard.db");
process.env.MOTARD_STARTUP_STATE = "FRESH";
// The desktop runtime refuses to CREATE a database without an installation
// identity (INSTALLATION_ID_REQUIRED) — mint one for this first-launch sim.
process.env.MOTARD_INSTALLATION_ID ??= randomUUID();
process.env.MOTARD_INSTALL_INSTANCE_ID ??= randomUUID();
process.env.MOTARD_DATA_ID ??= randomUUID();
delete process.env.DATABASE_URL;
delete process.env.DESKTOP_SEED_PATH;
const TENANT = randomUUID();

let server: Server;
let base = "";
let role = "admin";
type Runtime = typeof import("@/infrastructure/orm/sqlite/runtime.js");
let runtime: Runtime;

beforeAll(async () => {
  runtime = await import("@/infrastructure/orm/sqlite/runtime.js");
  await runtime.ensureSqliteRuntime();
  const w = runtime.getSqliteRuntime()!.conns.writer as unknown as import("better-sqlite3").Database;
  w.prepare(`INSERT INTO tenants (id, name, slug) VALUES (?, 'شركة التنزيل', 'dl')`).run(TENANT);
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
}, 120_000);

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  runtime?.shutdownSqliteRuntime();
  rmSync(root, { recursive: true, force: true });
});

describe("desktop backup delivery (T100)", () => {
  it("?deliver=metadata answers the VERIFIED file's identity instead of the bytes", async () => {
    const r = await fetch(`${base}/api/backup/full?deliver=metadata`, { method: "POST" });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toMatch(/json/);
    const m = (await r.json()) as { status: string; path: string; sizeBytes: number; sha256: string; fileName: string };
    expect(m.status).toBe("VERIFIED");
    expect(m.fileName).toMatch(/^MotardERP-Backup-\d{4}-\d{2}-\d{2}\.zip$/);
    expect(statSync(m.path).size).toBe(m.sizeBytes);
    expect(createHash("sha256").update(readFileSync(m.path)).digest("hex")).toBe(m.sha256);
  }, 60_000);

  it("without the flag the zip is still streamed (web path)", async () => {
    const r = await fetch(`${base}/api/backup/full`, { method: "POST" });
    expect(r.status).toBe(200);
    expect(r.headers.get("content-type")).toBe("application/zip");
    const bytes = new Uint8Array(await r.arrayBuffer());
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(r.headers.get("x-backup-sha256"));
  }, 60_000);

  it("the registry lists the backups newest first with their status", async () => {
    const r = await fetch(`${base}/api/backup/registry`);
    expect(r.status).toBe(200);
    const { entries } = (await r.json()) as { entries: Array<{ status: string; kind: string; exists: boolean; createdAt: string }> };
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries.every((e) => e.status === "VERIFIED" && e.kind === "manual" && e.exists)).toBe(true);
    expect(entries[0].createdAt >= entries[1].createdAt).toBe(true);
  });

  it("only an admin may read the registry", async () => {
    role = "accountant";
    try {
      expect((await fetch(`${base}/api/backup/registry`)).status).toBe(403);
    } finally {
      role = "admin";
    }
  });
});

describe("restore refusal messages", () => {
  it("a PostgreSQL-era (v2) archive is refused with its own code and message, not a generic restore failure", async () => {
    const { unzipSync, zipSync, strFromU8, strToU8 } = await import("fflate");
    const { writeFileSync } = await import("node:fs");
    const r = await fetch(`${base}/api/backup/full?deliver=metadata`, { method: "POST" });
    const { path } = (await r.json()) as { path: string };
    // same archive family, formatVersion 2 (what a PostgreSQL-era export declares)
    const e = unzipSync(new Uint8Array(readFileSync(path)));
    const man = JSON.parse(strFromU8(e["manifest.json"]));
    man.formatVersion = 2;
    e["manifest.json"] = strToU8(JSON.stringify(man));
    e["manifest.sha256"] = strToU8(createHash("sha256").update(e["manifest.json"]).digest("hex"));
    const v2 = join(root, "postgres-era.zip");
    writeFileSync(v2, zipSync(e));
    const { restoreUploadedBackup } = await import("@/presentation/routes/backup.route.js");
    const err = (await restoreUploadedBackup(v2, TENANT, true).catch((x: unknown) => x)) as { code?: string; message?: string };
    expect(err.code).toBe("BACKUP_UNSUPPORTED_FORMAT");
    expect(err.message).toMatch(/PostgreSQL/);
    expect(err.message).not.toMatch(/RESTORE_FAILED at/);
  }, 120_000);
});
