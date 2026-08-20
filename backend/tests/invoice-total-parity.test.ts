import { describe, it, expect } from "vitest";
import { computeSubtotal } from "@/domain/entities/Invoice.js";
import { invoiceSubtotal, lineTotal } from "../../src/core/calculations/invoiceCalc.js";

/**
 * P0-LOGIC regression: frontend and backend computed invoice totals
 * differently. Backend rounds each line then sums; frontend used to sum exact
 * values then let the display round once, so the preview diverged from the
 * journaled subtotal (e.g. 3 × 0.5kg @ 1 → backend 3 vs frontend 1.5).
 */
describe("invoice total parity (frontend vs backend)", () => {
  const cases = [
    {
      name: "3 x 0.5kg @ 1",
      lines: [
        { quantityKg: 0.5, pricePerKg: 1, discountAmount: 0 },
        { quantityKg: 0.5, pricePerKg: 1, discountAmount: 0 },
        { quantityKg: 0.5, pricePerKg: 1, discountAmount: 0 },
      ],
      backend: 3,
    },
    {
      name: "5 x 7.25kg @ 8750.50",
      lines: Array.from({ length: 5 }, () => ({
        quantityKg: 7.25,
        pricePerKg: 8750.5,
        discountAmount: 0,
      })),
      backend: 317205,
    },
  ];

  it.each(cases)("$name", ({ lines, backend }) => {
    expect(invoiceSubtotal({ lines })).toBe(backend);
    expect(computeSubtotal(lines as never)).toBe(backend);
    // Per-line behaviour is the actual fix: each line rounds independently.
    for (const l of lines) {
      expect(lineTotal(l)).toBe(Math.max(0, Math.round(l.quantityKg * l.pricePerKg - l.discountAmount)));
    }
  });
});