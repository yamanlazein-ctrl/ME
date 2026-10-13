/**
 * Lint finding react-hooks/exhaustive-deps ("unnecessary dependency: invVersion", 9 sites) — memos
 * read module-level caches React cannot see, keyed on an unused version number. The store now hands
 * out a snapshot whose IDENTITY changes on every change while its arrays are the live caches, so a
 * memo that reads `inventory.rolls` and depends on `inventory` recomputes exactly when the store does.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("@/infrastructure/container", () => ({ container: {} }));
vi.mock("@/infrastructure/di/auth-context", () => ({
  buildTenantContext: () => ({ tenantId: "t", userId: "u", userRole: "admin", userName: "x" }),
}));

import {
  decrementRoll,
  getInventorySnapshot,
  rolls,
  fabrics,
  colors,
} from "@/presentation/hooks/useInventory";
import { Roll, type RollData } from "@/domain/entities/Roll";

describe("inventory store snapshot", () => {
  it("is stable while nothing changes and new after a change; arrays are the live caches", () => {
    const before = getInventorySnapshot();
    expect(getInventorySnapshot()).toBe(before); // useSyncExternalStore needs a stable snapshot
    expect(before.rolls).toBe(rolls);
    expect(before.fabrics).toBe(fabrics);
    expect(before.colors).toBe(colors);

    rolls.push(
      Roll.reconstitute({ id: "r-1", remainingKg: 5, initialKg: 5 } as unknown as RollData),
    );
    decrementRoll("r-1", 2);
    const after = getInventorySnapshot();
    expect(after).not.toBe(before);
    expect(after.version).toBeGreaterThan(before.version);
    expect(after.rolls.find((r) => r.id === "r-1")?.remainingKg).toBe(3);
  });
});
