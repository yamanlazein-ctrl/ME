/**
 * CODEBASE_AUDIT_REPORT S-01 — the module-level party cache belongs to ONE session. Logout clears it,
 * and a load still in flight from the previous session is dropped instead of filling the next one.
 */
import { describe, it, expect, vi } from "vitest";

const gate = vi.hoisted(() => ({ release: null as null | (() => void), owner: "A" }));
const { execute } = vi.hoisted(() => ({
  execute: vi.fn(async (filter: { kind: string; status?: string }) => {
    const owner = gate.owner;
    if (owner === "A" && !filter.status && filter.kind === "customer")
      await new Promise<void>((r) => (gate.release = r));
    const data = filter.status
      ? []
      : [{ id: `${owner}-${filter.kind}`, kind: filter.kind, status: "active", name: owner }];
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

describe("useParties cache across sessions", () => {
  it("logout clears it; A's late response never reaches B's session", async () => {
    vi.stubGlobal("window", new EventTarget()); // node env: the module registers its session listeners on window
    const mod = await import("../useParties");
    const aLoad = mod.refreshParties(); // A's customer page is held open
    await vi.waitFor(() => expect(gate.release).not.toBeNull());

    window.dispatchEvent(new Event("erp:session-ended")); // A logs out
    expect(mod.customers).toEqual([]);

    gate.owner = "B";
    await mod.refreshParties(); // B's session loads
    expect(mod.customers.map((p) => p.id)).toEqual(["B-customer"]);

    gate.release!(); // A's stale response lands now
    await aLoad;
    expect(mod.customers.map((p) => p.id)).toEqual(["B-customer"]);
    expect(mod.suppliers.map((p) => p.id)).toEqual(["B-supplier"]);
  });
});
