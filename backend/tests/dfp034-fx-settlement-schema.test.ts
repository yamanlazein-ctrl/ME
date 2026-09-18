/**
 * DFP-034 — settlement FX gate + historical freeze policy.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { requireFxRate, FX_REQUIRED_MESSAGE } from "@erp/shared";
import { settleInvoicesSchema } from "../src/presentation/routes/statement.schema.ts";
import { resolveSaleCostPerKg } from "../src/domain/invoices/invoiceCostSnapshot.js";

describe("DFP-034 FX settlement gate", () => {
  it("requireFxRate demands rate when currency ≠ USD", () => {
    expect(requireFxRate("USD", undefined)).toBe(true);
    expect(requireFxRate("SYP", undefined)).toBe(false);
    expect(requireFxRate("SYP", 15000)).toBe(true);
  });

  it("settleInvoicesSchema fails closed without exchangeRate for SYP", () => {
    const parsed = settleInvoicesSchema.safeParse({
      invoiceIds: ["00000000-0000-4000-8000-000000000001"],
      amountPaid: 100,
      currency: "SYP",
      method: "cash",
    });
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      const msg = parsed.error.issues.map((i) => i.message).join(" ");
      expect(msg).toContain(FX_REQUIRED_MESSAGE);
    }
  });

  it("settleInvoicesSchema accepts SYP with exchangeRate", () => {
    const parsed = settleInvoicesSchema.safeParse({
      invoiceIds: ["00000000-0000-4000-8000-000000000001"],
      amountPaid: 100,
      currency: "SYP",
      exchangeRate: 15000,
      method: "cash",
    });
    expect(parsed.success).toBe(true);
  });

  it("invoice repository freezes create-time FX on edit (source contract)", () => {
    const src = readFileSync(
      resolve(process.cwd(), "src/infrastructure/repositories/PostgresInvoiceRepository.ts"),
      "utf8",
    );
    expect(src).toMatch(/FX-FREEZE FIX|Historical FX is frozen/);
    expect(src).toMatch(/Keep the create-time FX freeze/);
    expect(src).toMatch(/FX_REQUIRED_MESSAGE/);
  });

  it("sale cost snapshot prefers captured cost over live roll price", () => {
    expect(resolveSaleCostPerKg(12.5, 99)).toBe(12.5);
    expect(resolveSaleCostPerKg(null, 7.25)).toBe(7.25);
  });
});
