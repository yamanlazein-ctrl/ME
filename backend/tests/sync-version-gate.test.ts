/**
 * BC-2 (specs/002-mobile-app R6, S4): the hub refuses a sync push/pull from a client whose money-rules
 * version differs, and lets a request without the header through (delivered desktops send none).
 * Runs on both engines against the real sync routes, mounted the way background-sync.test.ts mounts them.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import express, { type RequestHandler } from "express";
import { MONEY_RULES_VERSION } from "@erp/shared";
import { db } from "@/infrastructure/orm/drizzle.js";
import {
  runWithPlatformContext,
  runWithTenantContext,
} from "@/infrastructure/orm/tenant-context.js";

const tenantId = randomUUID();
const userId = randomUUID();
const deviceId = randomUUID();
let server: http.Server;
let base = "";

const pass: RequestHandler = (_req, _res, next) => next();

beforeAll(async () => {
  await runWithPlatformContext(async () => {
    await db.execute(sql`
      insert into tenants (id, name, slug, status, license_status, license_type)
      values (${tenantId}, 'Version Gate Tenant', ${`vg-${tenantId.slice(0, 8)}`},
              'active', 'no_license', 'trial')
    `);
    await db.execute(sql`
      insert into users (id, tenant_id, name, email, password_hash, role)
      values (${userId}, ${tenantId}, 'مدير', ${`vg-${tenantId.slice(0, 8)}@test.local`}, 'x', 'admin')
    `);
  });

  const { buildContainer } = await import("@/infrastructure/di/container.js");
  const { registerSyncRoutes } = await import("@/presentation/routes/sync.route.js");
  const { syncVersionGuard } =
    await import("@/infrastructure/http/middleware/syncVersionGuard.middleware.js");
  const container = buildContainer();
  // A push is attributed to a registered device (sync_inbox references sync_devices).
  await runWithTenantContext({ tenantId, userId, userRole: "admin", userName: "مدير" }, () =>
    container.syncDeviceRepo.registerOrTouch({
      tenantId: tenantId as never,
      userId: userId as never,
      deviceFingerprint: `fp-${deviceId}`,
      deviceFingerprintVersion: 1,
      platform: "windows",
      hostname: "gate-pc",
      label: "gate-pc",
      deviceId: deviceId as never,
    }),
  );
  const auth: RequestHandler = (req, _res, next) => {
    req.tenantContext = {
      tenantId,
      userId,
      userRole: "admin",
      userName: "مدير",
      syncDeviceId: deviceId,
    };
    next();
  };
  const router = express.Router();
  registerSyncRoutes(
    router,
    container,
    auth,
    {
      readGuard: pass,
      transportGuard: pass,
      numberingGuard: pass,
      conflictGuard: pass,
      operatorGuard: pass,
      syncVersionGuard,
    },
    { attributed: pass, pull: pass, orchestration: pass },
  );
  server = http.createServer(express().use(express.json()).use("/api", router));
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
}, 60_000);

afterAll(async () => {
  await new Promise((r) => server?.close(r));
  await runWithPlatformContext(async () => {
    await db.execute(sql`delete from sync_inbox where tenant_id = ${tenantId}`);
    await db.execute(sql`delete from sync_devices where tenant_id = ${tenantId}`);
  });
});

const pushUnit = () => ({
  opId: randomUUID(),
  syncDeviceId: deviceId,
  entityType: "party",
  entityId: randomUUID(),
  operation: "create",
  payload: { name: "Gate Party", kind: "customer" },
});

async function call(path: "push" | "pull", header: string | null, unit = pushUnit()) {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (header !== null) headers["x-motard-money-version"] = header;
  const res =
    path === "push"
      ? await fetch(`${base}/sync/push`, { method: "POST", headers, body: JSON.stringify(unit) })
      : await fetch(`${base}/sync/pull?afterSeq=0&limit=10`, { headers });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("sync money-version gate (BC-2)", () => {
  it("matching X-Motard-Money-Version → 200 on push (replay of an accepted unit) and on pull", async () => {
    const unit = pushUnit();
    const first = await call("push", null, unit); // creates the unit (201)
    expect([200, 201]).toContain(first.status);
    const replay = await call("push", String(MONEY_RULES_VERSION), unit);
    expect(replay.status).toBe(200);
    expect((await call("pull", String(MONEY_RULES_VERSION))).status).toBe(200);
  });

  it("a different value → 426 SYNC_VERSION_MISMATCH on push and on pull", async () => {
    const wrong = String(MONEY_RULES_VERSION + 1);
    for (const path of ["push", "pull"] as const) {
      const r = await call(path, wrong);
      expect(r.status).toBe(426);
      expect(r.body).toMatchObject({
        code: "SYNC_VERSION_MISMATCH",
        hubVersion: MONEY_RULES_VERSION,
        clientVersion: MONEY_RULES_VERSION + 1,
      });
    }
  });

  it("header absent → 200 (delivered desktops keep syncing)", async () => {
    const unit = pushUnit();
    await call("push", null, unit);
    expect((await call("push", null, unit)).status).toBe(200);
    expect((await call("pull", null)).status).toBe(200);
  });
});
