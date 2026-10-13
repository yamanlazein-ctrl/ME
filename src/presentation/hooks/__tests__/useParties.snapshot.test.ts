/**
 * Lint finding react-hooks/exhaustive-deps (SupplierInlineCombobox, plus an eslint-disable that hid
 * the same finding in PartyTable) — memos keyed on an unused version number. The party store now
 * hands out a snapshot whose identity changes on every change; its arrays are the live caches.
 */
import { describe, it, expect, vi } from "vitest";

const { execute } = vi.hoisted(() => ({
  execute: vi.fn(async (filter: { kind: string; status?: string }) => {
    const data = filter.status
      ? []
      : [{ id: `p-${filter.kind}`, kind: filter.kind, status: "active", name: filter.kind }];
    return { data, meta: { total: data.length, hasNext: false, nextCursor: null } };
  }),
}));
vi.mock("@/infrastructure/container", () => ({ container: { parties: { list: { execute } } } }));
vi.mock("@/infrastructure/di/auth-context", () => ({
  buildTenantContext: () => ({ tenantId: "t" }),
}));
vi.mock("@/infrastructure/auth/TokenProvider", () => ({
  getAccessToken: () => null,
  SESSION_STARTED_EVENT: "erp:session-started",
  SESSION_ENDED_EVENT: "erp:session-ended",
}));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

describe("party store snapshot", () => {
  it("stable while unchanged, new after a load; arrays are the live caches", async () => {
    vi.stubGlobal("window", new EventTarget());
    const mod = await import("../useParties");
    const before = mod.getPartiesSnapshot();
    expect(mod.getPartiesSnapshot()).toBe(before);
    expect(before.suppliers).toBe(mod.suppliers);
    expect(before.customers).toBe(mod.customers);

    await mod.refreshParties();
    const after = mod.getPartiesSnapshot();
    expect(after).not.toBe(before);
    expect(after.version).toBeGreaterThan(before.version);
    expect(after.suppliers.map((p) => p.id)).toEqual(["p-supplier"]);
    vi.unstubAllGlobals();
  });
});
