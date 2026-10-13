/**
 * VERIFIED_REMEDIATION_PLAN ERP-002 — a user change and its sync outbox unit commit together: when
 * the enqueue fails, the change is rolled back (it used to stay committed locally and never reach the
 * hub or peers, while the client was told it failed). Real engine repository (container) + real route.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import express, { type RequestHandler } from "express";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/infrastructure/orm/drizzle.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import { users } from "@/infrastructure/orm/schemas/user.table.js";
import { buildContainer } from "@/infrastructure/di/container.js";
import { registerUserRoutes } from "@/presentation/routes/user.route.js";

const tenantId = randomUUID();
const adminId = randomUUID();
const clerkId = randomUUID();

async function call(method: string, path: string, outboxFails: boolean, body?: unknown) {
  const container = buildContainer();
  const outbox = outboxFails
    ? {
        enqueue: async () => {
          throw new Error("outbox down");
        },
      }
    : container.syncOutboxRepo;
  const auth: RequestHandler = (req, _res, next) => {
    (req as unknown as { tenantContext: unknown }).tenantContext = {
      tenantId,
      userId: adminId,
      userRole: "admin",
      userName: "A",
    };
    next();
  };
  const app = express();
  app.use(express.json());
  const router = express.Router();
  registerUserRoutes(
    router,
    container.userRepo,
    { hash: async (p: string) => `h:${p}` },
    auth,
    auth,
    outbox as never,
  );
  app.use("/api", router);
  const server = app.listen(0);
  await new Promise<void>((r) => server.once("listening", () => r()));
  try {
    const res = await fetch(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}/api${path}`,
      {
        method,
        headers: { "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
      },
    );
    return res.status;
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

const clerk = async () =>
  (
    await db
      .select({ role: users.role, active: users.active, hash: users.passwordHash })
      .from(users)
      .where(and(eq(users.id, clerkId), eq(users.tenantId, tenantId)))
  )[0];

describe("user mutation + outbox are atomic", () => {
  beforeAll(async () => {
    await db.execute(sql`select 1`);
    await db
      .insert(tenants)
      .values({ id: tenantId, name: "E2", slug: `e2-${tenantId.slice(0, 8)}` });
    const base = { tenantId, passwordHash: "h:orig" };
    await db.insert(users).values([
      { ...base, id: adminId, name: "A", email: `${adminId.slice(0, 8)}@x.io`, role: "admin" },
      { ...base, id: clerkId, name: "C", email: `${clerkId.slice(0, 8)}@x.io`, role: "warehouse" },
    ]);
  });

  it("a failed enqueue rolls back role change, password reset and deactivation", async () => {
    expect(await call("PATCH", `/users/${clerkId}`, true, { role: "viewer" })).toBe(500);
    expect(
      await call("POST", `/users/${clerkId}/reset-password`, true, { password: "abcd1234" }),
    ).toBe(500);
    expect(await call("DELETE", `/users/${clerkId}`, true)).toBe(500);
    expect(await clerk()).toEqual({ role: "warehouse", active: true, hash: "h:orig" });
  });

  it("with a working outbox the change commits", async () => {
    expect(await call("PATCH", `/users/${clerkId}`, false, { role: "viewer" })).toBe(200);
    expect((await clerk())?.role).toBe("viewer");
  });
});
