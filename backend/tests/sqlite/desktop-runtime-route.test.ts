/**
 * T083 (specs/001-desktop-sqlite-engine, D-1): the runtime-only endpoints the desktop shell calls
 * before applying an update — a VERIFIED pre-update backup, then a graceful stop with
 * wal_checkpoint(TRUNCATE). Reachable only with the runtime token (sha256 of APP_MASTER_KEY) on a
 * desktop SQLite deployment; anything else is a 404, as if the routes did not exist.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { mkdtempSync, rmSync, existsSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";

const root = mkdtempSync(join(tmpdir(), "motard-rt-"));
process.env.DB_ENGINE = "sqlite";
process.env.SQLITE_PATH = join(root, "data", "motard.db");
process.env.MOTARD_STARTUP_STATE = "FRESH";
delete process.env.DATABASE_URL;
delete process.env.DESKTOP_SEED_PATH;
const MASTER = `test-master-${randomUUID()}`;
const TOKEN = createHash("sha256").update(MASTER).digest("hex");

let server: Server;
let base = "";
let prev: { deploy?: string; key?: string; inst?: string };
type Runtime = typeof import("@/infrastructure/orm/sqlite/runtime.js");
let runtime: Runtime;

const post = (path: string, token?: string) =>
  fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...(token ? { "x-motard-runtime-token": token } : {}) },
    body: "{}",
  });

beforeAll(async () => {
  prev = { deploy: process.env.DESKTOP_DEPLOY, key: process.env.APP_MASTER_KEY, inst: process.env.MOTARD_INSTALLATION_ID };
  process.env.DESKTOP_DEPLOY = "true";
  process.env.MOTARD_INSTALLATION_ID = randomUUID(); // a desktop database is created FOR an installation
  process.env.APP_MASTER_KEY = MASTER;
  runtime = await import("@/infrastructure/orm/sqlite/runtime.js");
  await runtime.ensureSqliteRuntime();
  const w = runtime.getSqliteRuntime()!.conns.writer as unknown as import("better-sqlite3").Database;
  w.prepare(`INSERT INTO tenants (id, name, slug) VALUES (?, 'شركة التحديث', 'upd')`).run(randomUUID());
  const { registerDesktopRuntimeRoutes } = await import("@/presentation/routes/desktopRuntime.route.js");
  const app = express();
  app.use(express.json());
  const router = express.Router();
  registerDesktopRuntimeRoutes(router);
  app.use(router);
  server = await new Promise<Server>((res) => {
    const s = app.listen(0, "127.0.0.1", () => res(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
  runtime?.shutdownSqliteRuntime();
  if (prev.deploy === undefined) delete process.env.DESKTOP_DEPLOY;
  else process.env.DESKTOP_DEPLOY = prev.deploy;
  if (prev.key === undefined) delete process.env.APP_MASTER_KEY;
  else process.env.APP_MASTER_KEY = prev.key;
  if (prev.inst === undefined) delete process.env.MOTARD_INSTALLATION_ID;
  else process.env.MOTARD_INSTALLATION_ID = prev.inst;
  rmSync(root, { recursive: true, force: true });
});

describe("desktop runtime endpoints (T083)", () => {
  it("answer 404 without the runtime token or with a wrong one", async () => {
    expect((await post("/api/desktop/runtime/pre-update-backup")).status).toBe(404);
    expect((await post("/api/desktop/runtime/pre-update-backup", "0".repeat(64))).status).toBe(404);
    expect((await post("/api/desktop/runtime/shutdown", TOKEN.slice(1))).status).toBe(404);
  });

  it("answer 404 when the deployment is not the desktop", async () => {
    process.env.DESKTOP_DEPLOY = "false";
    try {
      expect((await post("/api/desktop/runtime/pre-update-backup", TOKEN)).status).toBe(404);
    } finally {
      process.env.DESKTOP_DEPLOY = "true";
    }
  });

  it("pre-update-backup creates a VERIFIED backup of kind pre-update", async () => {
    const r = await post("/api/desktop/runtime/pre-update-backup", TOKEN);
    expect(r.status).toBe(200);
    const body = (await r.json()) as { ok: boolean; path: string; sha256: string; sizeBytes: number };
    expect(body.ok).toBe(true);
    expect(existsSync(body.path)).toBe(true);
    expect(statSync(body.path).size).toBe(body.sizeBytes);
    const { readRegistry } = await import("@/infrastructure/backup/backupRegistry.js");
    const entry = readRegistry(root).entries.find((e: { path: string }) => e.path === body.path) as
      | { status: string; kind: string }
      | undefined;
    expect(entry?.status).toBe("VERIFIED");
    expect(entry?.kind).toBe("pre-update");
  });

  it("shutdown checkpoints the WAL to zero, closes the database and exits", async () => {
    const exit = vi.spyOn(process, "exit").mockImplementation((() => undefined) as never);
    try {
      const r = await post("/api/desktop/runtime/shutdown", TOKEN);
      expect(r.status).toBe(200);
      expect(await r.json()).toEqual({ ok: true, checkpointed: true });
      await new Promise((res) => setTimeout(res, 200));
      expect(exit).toHaveBeenCalledWith(0);
      expect(runtime.getSqliteRuntime()).toBeNull();
      const wal = `${process.env.SQLITE_PATH}-wal`;
      expect(!existsSync(wal) || statSync(wal).size === 0).toBe(true);
    } finally {
      exit.mockRestore();
    }
  });
});
