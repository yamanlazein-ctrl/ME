import { describe, it, expect } from "vitest";
import { round2dp } from "@erp/shared";
import { returnAmount } from "./useReturns";

const lines = (...l: [number, number][]) => ({
  lines: l.map(([quantityKg, pricePerKg]) => ({ quantityKg, pricePerKg })),
});

describe("returnAmount — same rounding the server posts (BUG-001)", () => {
  it("rounds each line half away from zero on the exact decimal product", () => {
    // 1.5 × 1.13 = 1.695 → 1.70 (the float product is 1.6949999…, which Math.round turned into 1.69)
    expect(returnAmount(lines([1.5, 1.13]))).toBe(1.7);
    expect(returnAmount(lines([1.5, 1.41]))).toBe(2.12);
  });

  it("sums the per-line rounded amounts", () => {
    expect(returnAmount(lines([1.5, 1.13], [1.5, 1.41]))).toBe(3.82);
    expect(returnAmount(lines([10, 5], [1, 9]))).toBe(59);
  });

  it("handles empty, zero and 4-decimal prices", () => {
    expect(returnAmount({ lines: [] })).toBe(0);
    expect(returnAmount(lines([0, 12.5]))).toBe(0);
    expect(returnAmount(lines([2.5, 5.3636]))).toBe(round2dp(2.5 * 5.3636));
  });

  it("agrees with the server rule round2dp(qty × price) for a grid of quantities and prices", () => {
    const bad: string[] = [];
    for (let q = 0.5; q <= 40; q += 0.5) {
      for (let c = 100; c <= 5000; c += 7) {
        const p = c / 100;
        if (returnAmount(lines([q, p])) !== round2dp(q * p)) bad.push(`${q}x${p}`);
      }
    }
    expect(bad).toEqual([]);
  });
});
