/**
 * The owner's number: what the cash in the drawer is actually worth as profit.
 * Bookkeeping shows the whole margin (52.50); only the collected part is cash.
 */
import { describe, it, expect } from "vitest";
import { cashProfitCollected } from "../CashPositionCard";

describe("cashProfitCollected", () => {
  it("apportions the margin over the part actually collected", () => {
    // 490 invoiced, 120 paid, cogs 437.50 → grossProfit 52.50
    // 120 × (52.50 / 490) = 12.857… → 12.86
    const share = cashProfitCollected(490, 120, 52.5);
    expect(share).toBeCloseTo(12.857, 3);
    expect(share.toFixed(2)).toBe("12.86");
  });

  it("counts a fully paid invoice at its full margin", () => {
    expect(cashProfitCollected(490, 490, 52.5)).toBeCloseTo(52.5, 10);
  });

  it("never counts more cash than the invoice is worth", () => {
    // Overpayment is a customer advance, not margin on this invoice.
    expect(cashProfitCollected(490, 900, 52.5)).toBeCloseTo(52.5, 10);
  });

  it("returns nothing for an unpaid or zero-value invoice", () => {
    expect(cashProfitCollected(490, 0, 52.5)).toBe(0);
    expect(cashProfitCollected(0, 120, 52.5)).toBe(0);
  });

  it("follows a loss all the way down", () => {
    expect(cashProfitCollected(100, 50, -20)).toBeCloseTo(-10, 10);
  });
});
