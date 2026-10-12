/**
 * CODEBASE_AUDIT_REPORT_hermes F-015 / F-016 / C1-11 — the user manager and the activity log read and
 * write the SERVER (users table, audit_logs), not device memory.
 */
import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { UsersApiService, changedUserFields, type TenantUserDTO } from "./UsersApiService";
import { AuditApiService } from "./AuditApiService";

const user = (i: number): TenantUserDTO => ({
  id: `u${i}`,
  name: `U${i}`,
  email: `u${i}@x.local`,
  role: "accountant",
  active: true,
  createdAt: "2026-10-01T00:00:00Z",
});

describe("UsersApiService", () => {
  it("walks every page of GET /api/users", async () => {
    const get = vi.fn(async (_p: string, cfg: { params: { page: string } }) => ({
      data:
        cfg.params.page === "0"
          ? { data: [user(1)], meta: { hasNext: true } }
          : { data: [user(2)], meta: { hasNext: false } },
    }));
    const api = new UsersApiService({ get } as never);
    expect((await api.list()).map((u) => u.id)).toEqual(["u1", "u2"]);
    expect(get).toHaveBeenCalledTimes(2);
  });

  it("PATCHes only changed fields and DELETEs to deactivate", async () => {
    const patch = vi.fn(async () => ({ data: {} }));
    const del = vi.fn(async () => ({ data: {} }));
    const api = new UsersApiService({ patch, delete: del } as never);
    const original = user(1);
    const changes = changedUserFields({ ...original, name: " جديد ", role: "viewer" }, original);
    expect(changes).toEqual({ name: "جديد", role: "viewer" });
    await api.update("u1", changes);
    await api.deactivate("u1");
    expect(patch).toHaveBeenCalledWith("/api/users/u1", { name: "جديد", role: "viewer" });
    expect(del).toHaveBeenCalledWith("/api/users/u1");
  });
});

describe("AuditApiService.listPage", () => {
  it("reads one page of the tenant audit trail with its total", async () => {
    const get = vi.fn(async () => ({
      data: {
        data: [{ id: 1, module: "invoices", action: "create", createdAt: "x" }],
        meta: { total: 7 },
      },
    }));
    const r = await new AuditApiService({ get } as never).listPage(100, 100);
    expect(r.total).toBe(7);
    expect(get).toHaveBeenCalledWith("/api/audit-logs", {
      params: { offset: "100", limit: "100" },
    });
  });
});

describe("settings pages use the server", () => {
  const route = (f: string) => readFileSync(join(__dirname, "../../routes", f), "utf8");
  it("F-015/C1-11: /settings/users uses the users API, never the in-memory list or a password field", () => {
    const src = route("settings.users.tsx");
    expect(src).toContain("container.users.api.list()");
    expect(src).toContain("container.users.api.update(");
    expect(src).toContain("container.users.api.deactivate(");
    expect(src).not.toMatch(/\baddUser\b|\bdeleteUser\b|s\.users|password/);
  });
  it("F-016: /settings/activity reads the audit trail and offers no client-side wipe", () => {
    const src = route("settings.activity.tsx");
    expect(src).toContain("container.audit.api.listPage(");
    expect(src).not.toMatch(/clearActivity|s\.activity/);
  });
});
