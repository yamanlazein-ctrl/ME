import { describe, expect, it } from "vitest";
import { invoiceRemaining } from "@/core/calculations/invoiceCalc";
import { invoiceRemaining as sharedRemaining } from "@erp/shared";

describe("invoiceRemaining (Phase 1 — returns-aware)", () => {
  it("delegates to @erp/shared and subtracts returns", () => {
    expect(invoiceRemaining(1000, 200, 100)).toBe(700);
    expect(invoiceRemaining(1000, 200, 100)).toBe(sharedRemaining(1000, 200, 100));
  });

  it("never goes negative when paid+returns exceed total", () => {
    expect(invoiceRemaining(500, 400, 200)).toBe(0);
  });

  it("defaults returns to 0 for new-invoice preview", () => {
    expect(invoiceRemaining(1000, 250)).toBe(750);
  });
});
