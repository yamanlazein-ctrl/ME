import { describe, it, expect, vi, beforeEach } from "vitest";
import { QueryClient, QueryObserver } from "@tanstack/react-query";

const findRollById = vi.fn();
vi.mock("@/infrastructure/container", () => ({
  container: { inventory: { repository: { findRollById: (...a: unknown[]) => findRollById(...a) } } },
}));
vi.mock("@/infrastructure/di/auth-context", () => ({
  buildTenantContext: () => ({ tenantId: "t-1", userId: "u-1", userRole: "admin", userName: "x" }),
}));

const { liveRollStockQuery, rolls, rollById } = await import("@/presentation/hooks/useInventory");
const { liveStockText } = await import("./LiveStockHint");
const { Roll } = await import("@/domain/entities/Roll");

const roll = (remainingPieces: number, remainingKg: number, version: number) =>
  Roll.reconstitute({
    id: "roll-A", tenantId: "t-1", colorId: "c-1", rollNo: "A", dyeBatch: "", initialKg: 500, remainingKg,
    pieces: 100, remainingPieces, pricePerKg: 3, currency: "USD", supplierId: "s-1", entryDate: "2026-03-01",
    version, createdAt: "2026-03-01T00:00:00Z",
  });

describe("live stock text", () => {
  it("says the real number, or nothing — never a default", () => {
    expect(liveStockText({ kind: "ready", pieces: 90, kg: 450 })).toBe("الموجود بالمخزون الآن: 90 ثوب — 450 كغ");
    expect(liveStockText({ kind: "ready", pieces: null, kg: 12.5 })).toBe("الموجود بالمخزون الآن: 12.5 كغ");
    expect(liveStockText({ kind: "unavailable" })).toBe("تعذّرت قراءة المخزون الآن");
    expect(liveStockText({ kind: "loading" })).not.toMatch(/\d/);
    expect(liveStockText({ kind: "none" })).toBeNull();
  });
});

describe("live roll stock query", () => {
  beforeEach(() => {
    findRollById.mockReset();
    rolls.splice(0, rolls.length, roll(100, 500, 1)); // the screen's list cache says 100
  });

  it("reads the server even when the list cache already has the roll, and refreshes that cache", async () => {
    findRollById.mockResolvedValue(roll(90, 450, 2)); // a sale of 10 happened
    const qc = new QueryClient();
    const live = await qc.fetchQuery(liveRollStockQuery("roll-A"));
    expect(findRollById).toHaveBeenCalledWith("roll-A", expect.anything());
    expect(live?.remainingPieces).toBe(90);
    expect(rollById("roll-A")?.remainingPieces).toBe(90); // exceeds-checks now use the same number
  });

  it("is never served from cache: always stale, refetched on mount/focus and on every stock movement", async () => {
    const q = liveRollStockQuery("roll-A");
    expect(q.staleTime).toBe(0);
    expect(q.refetchOnMount).toBe("always");
    expect(q.refetchOnWindowFocus).toBe("always");
    expect(q.queryKey[0]).toBe("inventory"); // invoices/returns/print jobs/orders invalidate ["inventory"]

    const qc = new QueryClient();
    findRollById.mockResolvedValueOnce(roll(100, 500, 1)).mockResolvedValueOnce(roll(90, 450, 2));
    const obs = new QueryObserver(qc, q);
    const unsub = obs.subscribe(() => {});
    await vi.waitFor(() => expect(obs.getCurrentResult().data?.remainingPieces).toBe(100));
    await qc.invalidateQueries({ queryKey: ["inventory"] }); // e.g. a sale invoice was saved
    await vi.waitFor(() => expect(obs.getCurrentResult().data?.remainingPieces).toBe(90));
    unsub();
  });

  it("does not query for a fabric-only placeholder or an empty selection", () => {
    expect(liveRollStockQuery("fabric:f-1").enabled).toBe(false);
    expect(liveRollStockQuery(undefined).enabled).toBe(false);
    expect(liveRollStockQuery("").enabled).toBe(false);
  });
});
