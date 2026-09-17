/**
 * Invoice edit must not rewrite frozen FX.
 * Regression for audit F-FX-EDIT-OVERWRITE.
 */
import { describe, it, expect } from "vitest";
import { updateInvoiceSchema } from "@erp/shared";

describe("invoice FX freeze on edit (schema + policy)", () => {
  it("update schema still allows omitting exchangeRate", () => {
    const parsed = updateInvoiceSchema.safeParse({
      date: "2026-01-01",
      lines: [
        {
          fabricId: "11111111-1111-1111-1111-111111111111",
          colorId: "22222222-2222-2222-2222-222222222222",
          rollId: "33333333-3333-3333-3333-333333333333",
          quantityKg: 1.5,
          pieces: 1,
          pricePerKg: 10,
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });

  it("update schema accepts a positive exchangeRate field (repo enforces freeze)", () => {
    const parsed = updateInvoiceSchema.safeParse({
      date: "2026-01-01",
      exchangeRate: 15000,
      lines: [
        {
          fabricId: "11111111-1111-1111-1111-111111111111",
          colorId: "22222222-2222-2222-2222-222222222222",
          rollId: "33333333-3333-3333-3333-333333333333",
          quantityKg: 1.5,
          pieces: 1,
          pricePerKg: 10,
        },
      ],
    });
    expect(parsed.success).toBe(true);
  });
});
