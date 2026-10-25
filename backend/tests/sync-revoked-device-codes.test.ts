/**
 * BC-3 (specs/002-mobile-app R7, FR-40): a revoked device gets 403 SYNC_DEVICE_REVOKED on push, on pull
 * and on the device-credential token exchange, so a phone can tell "wipe me" from any other 403.
 * Runs on both engines against the real sync routes and the real device gate.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import express, { type RequestHandler } from "express";
import { db } from "@/infrastructure/orm/drizzle.js";
import {
  runWithPlatformContext,
  runWithTenantContext,
} from "@/infrastructure/orm/tenant-context.js";

const tenantId = randomUUID();
const userId = randomUUID();
const deviceId = randomUUID();
let secret = "";
let server: http.Server;
let base = "";

beforeAll(async () => {
  await runWithPlatformContext(async () => {
    await db.execute(sql`
      insert into tenants (id, name, slug, status, license_status, license_type)
      values (${tenantId}, 'Revoked Codes Tenant', ${`rc-${tenantId.slice(0, 8)}`},
              'active', 'no_license', 'trial')
    `);
    await db.execute(sql`
      insert into users (id, tenant_id, name, email, password_hash, role)
      values (${userId}, ${tenantId}, 'مدير', ${`rc-${tenantId.slice(0, 8)}@test.local`}, 'x', 'admin')
    `);
  });

  const { buildContainer } = await import("@/infrastructure/di/container.js");
  const { registerSyncRoutes } = await import("@/presentation/routes/sync.route.js");
  const { registerSyncEnrollmentPublicRoutes } =
    await import("@/presentation/routes/syncEnrollment.route.js");
  const { createSyncDeviceGate } =
    await import("@/infrastructure/http/middleware/sync-device-gate.middleware.js");
  const { syncVersionGuard } =
    await import("@/infrastructure/http/middleware/syncVersionGuard.middleware.js");
  const { mintCredentialForBoundDevice } =
    await import("@/application/use-cases/sync/syncEnrollment.js");
  const container = buildContainer();
  const ctx = { tenantId, userId, userRole: "admin" as const, userName: "مدير" };

  await runWithTenantContext(ctx, () =>
    container.syncDeviceRepo.registerOrTouch({
      tenantId: tenantId as never,
      userId: userId as never,
      deviceFingerprint: `fp-${deviceId}`,
      deviceFingerprintVersion: 1,
      platform: "android",
      hostname: "phone-1",
      label: "phone-1",
      deviceId: deviceId as never,
    }),
  );
  const minted = await runWithTenantContext(ctx, () =>
    mintCredentialForBoundDevice(container, tenantId, deviceId, userId),
  );
  if (!minted.ok) throw new Error(`credential not minted: ${minted.code}`);
  secret = minted.deviceSecret;

  const pass: RequestHandler = (_req, _res, next) => next();
  const auth: RequestHandler = (req, _res, next) => {
    req.tenantContext = { ...ctx, syncDeviceId: deviceId };
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
      syncVersionGuard,
      numberingGuard: pass,
      conflictGuard: pass,
      operatorGuard: pass,
    },
    {
      attributed: createSyncDeviceGate(container.syncDeviceRepo, {
        unknownDevice: "reject",
        unboundUser: "reject",
      }),
      pull: createSyncDeviceGate(container.syncDeviceRepo, {
        unknownDevice: "reject",
        unboundUser: "reject",
        assertFromQuery: true,
      }),
      orchestration: pass,
    },
  );
  const root = express().use(express.json());
  registerSyncEnrollmentPublicRoutes(root, container);
  root.use("/api", router);
  server = http.createServer(root);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
}, 60_000);

afterAll(async () => {
  await new Promise((r) => server?.close(r));
});

const post = async (path: string, body: unknown) => {
  const res = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
const pull = async () => {
  const res = await fetch(`${base}/sync/pull?afterSeq=0&limit=10`);
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
};
const push = () =>
  post("/sync/push", {
    opId: randomUUID(),
    syncDeviceId: deviceId,
    entityType: "party",
    entityId: randomUUID(),
    operation: "create",
    payload: { name: "Revoked Party", kind: "customer" },
  });
const token = () => post("/sync/device-token", { tenantId, deviceId, secret });

describe("revoked device reason codes (BC-3)", () => {
  it("before revoke: push, pull and token exchange are not refused as revoked", async () => {
    expect((await push()).body.code).not.toBe("SYNC_DEVICE_REVOKED");
    expect((await pull()).status).toBe(200);
    expect((await token()).body.code).not.toBe("SYNC_DEVICE_REVOKED");
  });

  it("after an admin revoke: 403 SYNC_DEVICE_REVOKED on push, pull and device-token", async () => {
    const revoke = await post(`/sync/devices/${deviceId}/revoke`, {});
    expect(revoke.status).toBe(200);

    const pushed = await push();
    expect(pushed.status).toBe(403);
    expect(pushed.body.code).toBe("SYNC_DEVICE_REVOKED");

    const pulled = await pull();
    expect(pulled.status).toBe(403);
    expect(pulled.body.code).toBe("SYNC_DEVICE_REVOKED");

    const exchanged = await token();
    expect(exchanged.status).toBe(403);
    expect(exchanged.body.code).toBe("SYNC_DEVICE_REVOKED");
  });
});
