import { describe, it, expect } from "vitest";
import { assertRollPriceEditAllowed } from "@/domain/invoices/rollCostFreeze";
import { BusinessRuleError } from "@/domain/errors/index";

/**
 * Regression test for F05 (Phase 1 foundation audit): "inventory cost
 * differs between invoice and GL/report". A roll's pricePerKg used to stay
 * freely editable via PUT /inventory/rolls/:id even after some of its
 * stock had already been sold and its cost frozen into posted COGS/GL
 * entries — so the live inventory report (priced at the CURRENT
 * pricePerKg) could silently diverge from what the GL and already-issued
 * invoices actually recorded.
 */
describe("assertRollPriceEditAllowed (F05 regression)", () => {
  const base = {
    rollNo: "R-1001",
    initialKg: 100,
    remainingKg: 100,
    currentPricePerKg: 1000,
  };

  it("allows a price edit on a roll with NO stock sold yet (pure data-entry correction)", () => {
    expect(() =>
      assertRollPriceEditAllowed({ ...base, remainingKg: 100, newPricePerKg: 1200 }),
    ).not.toThrow();
  });

  it("blocks a price edit once ANY stock has been sold from the roll", () => {
    expect(() =>
      assertRollPriceEditAllowed({ ...base, remainingKg: 99.9, newPricePerKg: 1200 }),
    ).toThrow(BusinessRuleError);
  });

  it("blocks a price edit on a fully-sold (exhausted) roll", () => {
    expect(() =>
      assertRollPriceEditAllowed({ ...base, remainingKg: 0, newPricePerKg: 1200 }),
    ).toThrow(BusinessRuleError);
  });

  it("does NOT block a no-op update — saving the form without actually changing the price", () => {
    expect(() =>
      assertRollPriceEditAllowed({ ...base, remainingKg: 50, newPricePerKg: 1000 }),
    ).not.toThrow();
  });

  it("does not false-positive on floating-point noise (same price re-saved)", () => {
    expect(() =>
      assertRollPriceEditAllowed({
        ...base,
        remainingKg: 50,
        currentPricePerKg: 0.1 + 0.2, // 0.30000000000000004 in IEEE 754
        newPricePerKg: 0.3,
      }),
    ).not.toThrow();
  });

  it("includes the roll number in the rejection message so the user knows which roll", () => {
    try {
      assertRollPriceEditAllowed({ ...base, remainingKg: 40, newPricePerKg: 1500 });
      expect.unreachable();
    } catch (e) {
      expect(e).toBeInstanceOf(BusinessRuleError);
      expect((e as Error).message).toContain("R-1001");
    }
  });
});
