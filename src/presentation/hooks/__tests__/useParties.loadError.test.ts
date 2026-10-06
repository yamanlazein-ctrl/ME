/**
 * D-3 / FR-068: a failed party load is reported as an error with Retry — it is
 * never presented as an empty ("no customers") list.
 */
import { describe, it, expect, vi } from "vitest";

const state = vi.hoisted(() => ({ fail: true }));
const { execute } = vi.hoisted(() => ({
  execute: vi.fn(async (filter: { kind: string; status?: string }) => {
    if (state.fail) throw new Error("network down");
    const data =
      filter.kind === "customer" && !filter.status ? [{ id: "c1", kind: "customer", status: "active", name: "A" }] : [];
    return { data, meta: { total: data.length, hasNext: false, nextCursor: null } };
  }),
}));

vi.mock("@/infrastructure/container", () => ({ container: { parties: { list: { execute } } } }));
vi.mock("@/infrastructure/di/auth-context", () => ({ buildTenantContext: () => ({ tenantId: "t" }) }));
vi.mock("@/infrastructure/auth/TokenProvider", () => ({ getAccessToken: () => null, SESSION_STARTED_EVENT: "x" }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

describe("useParties load state — D-3", () => {
  it("reports an error (not an empty list) when loading fails, and Retry recovers", async () => {
    const mod = await import("../useParties");
    await mod.refreshParties();
    const failed = mod.getPartiesLoadState();
    expect(failed.status).toBe("error");
    expect(failed.status === "error" && failed.message).toContain("network down");
    expect(mod.customers).toHaveLength(0);

    state.fail = false;
    await mod.retryPartiesLoad();
    expect(mod.getPartiesLoadState().status).toBe("ready");
    expect(mod.customers.map((p) => p.id)).toEqual(["c1"]);
  });
});
