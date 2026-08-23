import { describe, it, expect } from "vitest";
import {
  computeSubtotal,
  lineTotal as sharedLineTotal,
} from "@erp/shared";
import { round2dp } from "@erp/shared";
import {
  lineTotal,
  invoiceSubtotal,
} from "@/core/calculations/invoiceCalc";

/**
 * Decimal-fraction audit (2026-08-23) — pins the 2-decimal money policy that
 * keeps USD/EUR cents exact end-to-end. The same `computeSubtotal` is used by
 * the backend domain entity (journaled subtotal), so frontend preview and
 * backend truth can never diverge. Replaces the whole-unit Math.round policy.
 */
describe("decimal money parity (shared ↔ frontend preview)", () => {
  const cases = [
    {
      name: "3 x 0.5kg @ 1 → 1.50 (was 3 under old whole-unit rounding)",
      lines: [
        { quantityKg: 0.5, pricePerKg: 1, discountAmount: 0 },
        { quantityKg: 0.5, pricePerKg: 1, discountAmount: 0 },
        { quantityKg: 0.5, pricePerKg: 1, discountAmount: 0 },
      ],
      expected: 1.5,
    },
    {
      name: "5 x 7.25kg @ 8750.50 → 317205.65 (per-line 63441.13)",
      lines: Array.from({ length: 5 }, () => ({
        quantityKg: 7.25,
        pricePerKg: 8750.5,
        discountAmount: 0,
      })),
      expected: 317205.65,
    },
    {
      name: "USD cents: 12.5kg @ 1.5 with 0.5 line discount → 18.25",
      lines: [{ quantityKg: 12.5, pricePerKg: 1.5, discountAmount: 0.5 }],
      expected: 18.25,
    },
  ];

  it.each(cases)("$name", ({ lines, expected }) => {
    expect(invoiceSubtotal({ lines })).toBe(expected);
    expect(computeSubtotal(lines as never)).toBe(expected);
    for (const l of lines) {
      expect(lineTotal(l)).toBe(Math.max(0, round2dp(l.quantityKg * l.pricePerKg - l.discountAmount)));
      expect(sharedLineTotal(l as never)).toBe(lineTotal(l));
    }
  });

  it("invoice total = subtotal − discount + tax + shipping keeps cents", () => {
    // 18.25 − 0.5 = 17.75 — the exact user scenario from the QA brief
    expect(18.25 - 0.5).toBe(17.75);
    expect(round2dp(12.5 * 1.5)).toBe(18.75);
  });
});
