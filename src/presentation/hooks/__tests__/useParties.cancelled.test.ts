/**
 * D-4 / FR-017: cancelled customers/suppliers never reach the operational
 * caches (`customers`, `suppliers` — the lists and pickers), but historical
 * documents still resolve them by id.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const rows = vi.hoisted(() => [
  { id: "c-active", kind: "customer", status: "active", name: "A" },
  { id: "c-inactive", kind: "customer", status: "inactive", name: "I" },
  { id: "c-cancelled", kind: "customer", status: "cancelled", name: "X" },
  { id: "s-active", kind: "supplier", status: "active", name: "SA" },
  { id: "s-cancelled", kind: "supplier", status: "cancelled", name: "SX" },
]);

const { execute } = vi.hoisted(() => ({ execute: vi.fn(async (filter: { kind: string; status?: string }) => {
  // Mirrors the backend contract: no status → cancelled excluded; explicit status → exact match.
  const data = rows.filter(
    (r) => r.kind === filter.kind && (filter.status ? r.status === filter.status : r.status !== "cancelled"),
  );
  return { data, meta: { total: data.length, hasNext: false, nextCursor: null } };
}) }));

vi.mock("@/infrastructure/container", () => ({ container: { parties: { list: { execute } } } }));
vi.mock("@/infrastructure/di/auth-context", () => ({ buildTenantContext: () => ({ tenantId: "t" }) }));
vi.mock("@/infrastructure/auth/TokenProvider", () => ({ getAccessToken: () => null, SESSION_STARTED_EVENT: "x" }));
vi.mock("sonner", () => ({ toast: { success: vi.fn(), error: vi.fn() } }));

describe("useParties cache — D-4 cancelled parties", () => {
  beforeEach(() => {
    execute.mockClear();
  });

  it("operational lists exclude cancelled; by-id lookups still resolve them", async () => {
    const mod = await import("../useParties");
    await mod.refreshParties();
    expect(mod.customers.map((p) => p.id).sort()).toEqual(["c-active", "c-inactive"]);
    expect(mod.suppliers.map((p) => p.id)).toEqual(["s-active"]);
    expect(mod.customerById("c-cancelled")?.id).toBe("c-cancelled");
    expect(mod.supplierById("s-cancelled")?.id).toBe("s-cancelled");
    expect(mod.customerById("c-active")?.id).toBe("c-active");
  });

  it("requests the cancelled set only through the explicit status filter", async () => {
    const mod = await import("../useParties");
    await mod.refreshParties();
    const statuses = execute.mock.calls.map((c) => (c[0] as { status?: string }).status ?? "default");
    expect(statuses.filter((s) => s === "cancelled")).toHaveLength(2);
    expect(statuses.filter((s) => s === "default")).toHaveLength(2);
  });
});
