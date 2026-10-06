/**
 * Background sync: with a paired device and NOBODY logged in (no request at
 * all), the backend timer runs the same push/pull cycle against the hub,
 * asserting this device's id; while the UI is driving runs it stays out of
 * the way; and an unpaired device makes no hub traffic.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import express, { type RequestHandler } from "express";

const root = mkdtempSync(join(tmpdir(), "motard-bgsync-"));
process.env.DB_ENGINE = "sqlite";
process.env.SQLITE_PATH = join(root, "data", "motard.db");
process.env.MOTARD_STARTUP_STATE = "FRESH";
process.env.HUB_CONFIG_PATH = join(root, "hub.json");
process.env.HUB_SESSION_PATH = join(root, "hub-session.json");
delete process.env.DATABASE_URL;
delete process.env.DESKTOP_SEED_PATH;
delete process.env.CENTRAL_SYNC_URL;

const tenantId = randomUUID();
const userId = randomUUID();
const deviceId = randomUUID();
const hits: Array<{ path: string; auth?: string; device?: string }> = [];
let server: http.Server;
let hubUrl = "";
let runtime: typeof import("@/infrastructure/orm/sqlite/runtime.js");
let start: (everyMs?: number) => () => void;
let runRoute: express.Express;

const until = async (cond: () => boolean, ms = 5_000) => {
  const end = Date.now() + ms;
  while (!cond() && Date.now() < end) await new Promise((r) => setTimeout(r, 25));
  return cond();
};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    hits.push({
      path: (req.url ?? "").split("?")[0],
      auth: req.headers.authorization,
      device: req.headers["x-sync-device-id"] as string | undefined,
    });
    res.writeHead(200, { "Content-Type": "application/json" });
    if ((req.url ?? "").startsWith("/api/sync/pull")) return res.end(JSON.stringify({ items: [] }));
    if ((req.url ?? "").startsWith("/api/sync/activity")) return res.end(JSON.stringify({ items: [] }));
    res.end("{}");
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  hubUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  runtime = await import("@/infrastructure/orm/sqlite/runtime.js");
  const tx = await import("@/infrastructure/orm/sqlite/transaction.js");
  await runtime.ensureSqliteRuntime();
  await tx.runInTransaction(async (t) => {
    await t.execute(sql`INSERT INTO tenants (id, name, slug) VALUES (${tenantId}, 'Local Co', 'local')`);
    await t.execute(sql`INSERT INTO users (id, tenant_id, name, email, password_hash, role)
                        VALUES (${userId}, ${tenantId}, 'مدير', 'admin@local.test', 'x', 'admin')`);
  });

  const { buildContainer } = await import("@/infrastructure/di/container.js");
  const { registerSyncRoutes } = await import("@/presentation/routes/sync.route.js");
  const container = buildContainer();
  const pass: RequestHandler = (_req, _res, next) => next();
  const auth: RequestHandler = (req, _res, next) => {
    req.tenantContext = { tenantId, userId, userRole: "admin", userName: "مدير", syncDeviceId: deviceId };
    next();
  };
  const router = express.Router();
  const rt = registerSyncRoutes(
    router,
    container,
    auth,
    { readGuard: pass, transportGuard: pass, numberingGuard: pass, conflictGuard: pass, operatorGuard: pass },
    { attributed: pass, pull: pass, orchestration: pass },
  );
  start = rt.startBackgroundSync;
  runRoute = express().use(express.json()).use(router);
}, 60_000);

afterAll(async () => {
  await new Promise((r) => server.close(r));
  runtime?.shutdownSqliteRuntime();
  rmSync(root, { recursive: true, force: true });
});

describe("background sync", () => {
  it("does nothing while the device is not paired", async () => {
    const stop = start(30);
    await new Promise((r) => setTimeout(r, 300));
    stop();
    expect(hits).toHaveLength(0);
  });

  it("runs push/pull as this device with nobody logged in", async () => {
    writeFileSync(process.env.HUB_CONFIG_PATH!, JSON.stringify({ url: hubUrl }));
    writeFileSync(
      process.env.HUB_SESSION_PATH!,
      JSON.stringify({ accessToken: "hub-token-xyz", hubUrl, hubDeviceId: deviceId, localTenantId: tenantId, localUserId: userId }),
    );
    const stop = start(30);
    const pulled = await until(() => hits.some((h) => h.path === "/api/sync/pull"));
    stop();
    expect(pulled).toBe(true);
    const pull = hits.find((h) => h.path === "/api/sync/pull")!;
    expect(pull.auth).toBe("Bearer hub-token-xyz");
    expect(pull.device).toBe(deviceId);
  });

  it("stays out of the way while the UI is running syncs", async () => {
    // let the previous test's in-flight cycle finish (stop() only cancels future ticks)
    for (let n = -1; n !== hits.length; ) {
      n = hits.length;
      await new Promise((r) => setTimeout(r, 250));
    }
    const res = await new Promise<number>((resolve) => {
      const srv = runRoute.listen(0, "127.0.0.1", () => {
        const port = (srv.address() as AddressInfo).port;
        fetch(`http://127.0.0.1:${port}/sync/run`, { method: "POST" })
          .then((r) => r.status)
          .finally(() => srv.close())
          .then(resolve);
      });
    });
    expect(res).toBe(200);
    hits.length = 0;
    const stop = start(30);
    await new Promise((r) => setTimeout(r, 300));
    stop();
    expect(hits.map((h) => h.path)).toEqual([]); // a UI run just happened: the timer waits
  });
});
