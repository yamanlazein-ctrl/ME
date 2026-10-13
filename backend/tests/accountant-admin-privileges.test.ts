/**
 * Owner decision 2026-10-12 — the accountant holds every admin privilege; the only things reserved
 * for the admin role are granting the admin role (directly or by invitation) and touching an admin
 * account. Nobody changes their own role. Release mission 2026-10-13: creating invitation codes is
 * the admin's alone (the accountant cannot create any).
 */
import { describe, it, expect, vi } from "vitest";
import { randomUUID } from "node:crypto";
import type { AddressInfo } from "node:net";
import express, { type RequestHandler } from "express";

vi.mock("@/application/use-cases/invitation/invitationUseCases.js", () => ({
  generateInvitationCodeUseCase: vi.fn(async () => ({ ok: true, data: { code: "C" } })),
  listInvitationCodesUseCase: vi.fn(),
  revokeInvitationCodeUseCase: vi.fn(),
  validateInvitationCodeUseCase: vi.fn(),
  consumeInvitationCodeUseCase: vi.fn(),
}));

import { rbac } from "@/infrastructure/http/middleware/rbac.middleware.js";
import { registerUserRoutes } from "@/presentation/routes/user.route.js";
import { registerInvitationAdminRoutes } from "@/presentation/routes/invitation.route.js";
import { generateInvitationCodeUseCase } from "@/application/use-cases/invitation/invitationUseCases.js";

type Role = "admin" | "accountant" | "warehouse" | "viewer";
const ME = randomUUID();
const ADMIN = randomUUID();
const CLERK = randomUUID();

async function call(role: Role, method: string, path: string, body?: unknown) {
  const users: Record<string, { id: string; role: string }> = {
    [ME]: { id: ME, role },
    [ADMIN]: { id: ADMIN, role: "admin" },
    [CLERK]: { id: CLERK, role: "warehouse" },
  };
  const update = vi.fn(async (id: string) => ({ id }));
  const del = vi.fn(async () => undefined);
  const repo = {
    findById: async (id: string) => users[id] ?? null,
    update,
    delete: del,
    findSyncSnapshot: async () => null,
    list: async () => ({ data: Object.values(users), total: 3 }),
  };
  const auth: RequestHandler = (req, _res, next) => {
    (req as unknown as { tenantContext: unknown }).tenantContext = {
      tenantId: randomUUID(),
      userId: ME,
      userRole: role,
    };
    next();
  };
  const app = express();
  app.use(express.json());
  const router = express.Router();
  registerUserRoutes(
    router,
    repo as never,
    { hash: async (p) => p },
    auth,
    rbac(["admin"]),
    {} as never,
  );
  registerInvitationAdminRoutes(router, {} as never, auth as never, rbac(["admin"]));
  router.put("/settings/company", auth, rbac(["admin"]), (_q, r) => void r.json({ ok: true }));
  router.post("/rolls", auth, rbac(["admin", "warehouse"]), (_q, r) => void r.json({ ok: true }));
  app.use("/api", router);
  app.use(router); // invitation routes carry their own /api prefix
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
    return { status: res.status, writes: update.mock.calls.length + del.mock.calls.length };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

describe("accountant = admin, except the admin role itself", () => {
  it("passes every admin-only guard; other roles still do not", async () => {
    expect((await call("accountant", "PUT", "/settings/company", {})).status).toBe(200);
    expect((await call("accountant", "POST", "/rolls", {})).status).toBe(200);
    expect((await call("accountant", "GET", "/users")).status).toBe(200); // ERP-004: exact success
    expect((await call("warehouse", "PUT", "/settings/company", {})).status).toBe(403);
    expect((await call("viewer", "GET", "/users")).status).toBe(403);
  });

  it("manages non-admin users", async () => {
    const r = await call("accountant", "PATCH", `/users/${CLERK}`, { role: "viewer", name: "x" });
    expect(r).toEqual({ status: 200, writes: 1 });
    expect((await call("accountant", "DELETE", `/users/${CLERK}`)).writes).toBe(1);
  });

  it("cannot grant the admin role, nor change, deactivate, delete or reset an admin", async () => {
    for (const [method, path, body] of [
      ["PATCH", `/users/${CLERK}`, { role: "admin" }],
      ["PATCH", `/users/${ADMIN}`, { role: "viewer" }],
      ["PATCH", `/users/${ADMIN}`, { active: false }],
      ["DELETE", `/users/${ADMIN}`, undefined],
      ["POST", `/users/${ADMIN}/reset-password`, { password: "abcd1234" }],
    ] as const) {
      expect(await call("accountant", method, path, body)).toEqual({ status: 403, writes: 0 });
    }
  });

  it("nobody changes their own role (admin included)", async () => {
    expect(await call("accountant", "PATCH", `/users/${ME}`, { role: "admin" })).toEqual({
      status: 400,
      writes: 0,
    });
    expect(await call("admin", "PATCH", `/users/${ME}`, { role: "viewer" })).toEqual({
      status: 400,
      writes: 0,
    });
    expect((await call("accountant", "PATCH", `/users/${ME}`, { name: "me" })).writes).toBe(1);
  });

  it("the admin keeps full rights over roles", async () => {
    expect((await call("admin", "PATCH", `/users/${CLERK}`, { role: "admin" })).writes).toBe(1);
    expect((await call("admin", "PATCH", `/users/${ADMIN}`, { role: "viewer" })).writes).toBe(1);
  });

  it("invites: the admin only — the accountant cannot create any invitation code", async () => {
    const inv = (role: Role, targetRole: string) =>
      call(role, "POST", "/invitations/generate", {
        type: "user",
        targetName: "n",
        targetEmail: "n@x.io",
        targetRole,
      });
    const generate = vi.mocked(generateInvitationCodeUseCase);
    generate.mockClear();
    expect((await inv("accountant", "viewer")).status).toBe(403);
    expect((await inv("accountant", "admin")).status).toBe(403);
    expect(
      (await call("accountant", "POST", "/invitations/generate", { type: "device" })).status,
    ).toBe(403);
    expect(generate).not.toHaveBeenCalled();
    expect((await inv("admin", "admin")).status).toBe(200);
    expect((await inv("admin", "viewer")).status).toBe(200);
    expect((await inv("warehouse", "viewer")).status).toBe(403);
  });
});
