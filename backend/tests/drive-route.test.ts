/**
 * HTTP surface of the Drive archive router (audit D-02, D-05, D-07). The 59 component tests never
 * mounted `createDriveRouter`, which is how a guard reading a nonexistent `req.ctx` 401'd every call
 * while the suite stayed green.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import type { Server } from "node:http";
import express from "express";

process.env.DB_ENGINE = "sqlite";
process.env.SQLITE_PATH = join(mkdtempSync(join(tmpdir(), "motard-drive-route-")), "data", "motard.db");
process.env.MOTARD_STARTUP_STATE = "FRESH";
process.env.MOTARD_INSTALLATION_ID ??= randomUUID();
process.env.MOTARD_INSTALL_INSTANCE_ID ??= randomUUID();
process.env.MOTARD_DATA_ID ??= randomUUID();
delete process.env.DATABASE_URL;
delete process.env.DESKTOP_SEED_PATH;

let server: Server;
let base = "";
const tenantId = randomUUID();

const call = (method: string, path: string, role?: string) =>
  fetch(`${base}/api${path}`, { method, headers: role ? { "x-test-role": role } : {} });

beforeAll(async () => {
  const rtm = await import("../src/infrastructure/orm/sqlite/runtime.js");
  await rtm.ensureSqliteRuntime({});
  const raw = rtm.getSqliteRuntime()!.conns.writer;
  raw.prepare(`INSERT INTO tenants (id, name, slug) VALUES (?, 't', 'drive-route')`).run(tenantId);
  raw.prepare(`INSERT INTO settings (id, tenant_id, drive) VALUES (?, ?, ?)`).run(
    randomUUID(),
    tenantId,
    JSON.stringify({ archiveEnabled: true, coordinatorDeviceId: "this-device" }),
  );
  const db = (await import("../src/infrastructure/orm/sqlite/transaction.js")).sqliteDb() as never;
  const { createDriveRouter } = await import("../src/presentation/routes/drive.route.js");
  const { UploadQueue } = await import("../src/infrastructure/googledrive/uploadQueue.js");
  const app = express();
  // Stand-in for authMiddleware: the real one sets req.tenantContext (auth.middleware.ts).
  app.use((req, _res, next) => {
    const role = req.headers["x-test-role"];
    if (typeof role === "string") (req as unknown as { tenantContext: unknown }).tenantContext = { tenantId, userId: "u", userRole: role };
    next();
  });
  app.use(
    "/api",
    createDriveRouter({
      db,
      driveClient: null,
      localDeviceId: "this-device",
      queue: new UploadQueue(db, null as never, null as never),
      syncNow: async () => ({ queued: 0, started: false }),
    }),
  );
  server = await new Promise<Server>((res) => {
    const s = app.listen(0, "127.0.0.1", () => res(s));
  });
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  if (server) await new Promise((r) => server.close(r));
});

describe("drive routes", () => {
  it("D-02: an admin reaches /drive/status; a non-admin is 403; no session is 401", async () => {
    const ok = await call("GET", "/drive/status", "admin");
    expect(ok.status).toBe(200);
    const body = (await ok.json()) as { archiveEnabled: boolean; isPrimaryDevice: boolean; localDeviceId: string; connected: boolean };
    expect(body).toMatchObject({ archiveEnabled: true, isPrimaryDevice: true, localDeviceId: "this-device", connected: false });
    expect((await call("GET", "/drive/status", "viewer")).status).toBe(403);
    expect((await call("GET", "/drive/status")).status).toBe(401);
  });

  it("D-02: every drive route is admin-only", async () => {
    for (const [method, path] of [
      ["POST", "/drive/test"],
      ["POST", "/drive/sync-now"],
      ["GET", "/drive/queue"],
      ["POST", `/drive/queue/${randomUUID()}/retry`],
    ]) {
      expect((await call(method, path, "accountant")).status, `${method} ${path}`).toBe(403);
    }
    expect((await call("POST", "/drive/test", "admin")).status).toBe(409); // NOT_CONNECTED, past the guard
  });
});
