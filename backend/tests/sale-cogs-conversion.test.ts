import { describe, it, expect } from "vitest";
import { resolveSaleLineCogs } from "@/domain/invoices/saleCogsConversion";
import { BusinessRuleError } from "@/domain/errors/index";

/**
 * Regression test for F02 (Phase 1 foundation audit): cross-currency COGS
 * was reported to produce nonsensical values — selling 6.8 kg from
 * SYP-costed stock produced a COGS of 9.07 USD while the SYP quantity
 * stayed in the GL, implying a synthetic rate (effectively rate=1) was
 * substituted instead of requiring the caller's real manual exchange rate.
 *
 * The current code (PostgresInvoiceRepository.create()/update()) already
 * guards against this — this test locks that guard in via the extracted
 * pure function both call sites now share, so a future edit to either path
 * can't silently reintroduce the bug in just one of them.
 */
describe("resolveSaleLineCogs (F02 regression)", () => {
  it("passes the amount through unchanged when roll and invoice share a currency", () => {
    expect(resolveSaleLineCogs(6800, "SYP", "SYP", null)).toBe(6800);
  });

  it("fails CLOSED (throws) instead of silently substituting a synthetic rate when no manual rate is given", () => {
    // 6.8kg of SYP-costed stock, no exchange rate supplied at all — this is
    // exactly the audited scenario. Must reject, not produce a number.
    expect(() => resolveSaleLineCogs(6800, "SYP", "USD", null)).toThrow(BusinessRuleError);
    expect(() => resolveSaleLineCogs(6800, "SYP", "USD", undefined)).toThrow(BusinessRuleError);
  });

  it("fails closed when the supplied rate is invalid (zero, negative, non-finite)", () => {
    expect(() => resolveSaleLineCogs(6800, "SYP", "USD", 0)).toThrow(BusinessRuleError);
    expect(() => resolveSaleLineCogs(6800, "SYP", "USD", -100)).toThrow(BusinessRuleError);
    expect(() => resolveSaleLineCogs(6800, "SYP", "USD", NaN)).toThrow(BusinessRuleError);
  });

  it("correctly converts SYP-costed stock into USD COGS using the real manual rate", () => {
    // 6800 SYP at a manual rate of 15000 SYP per 1 USD → 0.45 USD (rounded
    // to 2dp), never a magnitude-wrong figure like 9.07.
    const cogs = resolveSaleLineCogs(6800, "SYP", "USD", 15000);
    expect(cogs).toBeCloseTo(0.45, 2);
    expect(cogs).not.toBeCloseTo(9.07, 1);
  });

  it("correctly converts USD-costed stock into SYP COGS using the real manual rate", () => {
    const cogs = resolveSaleLineCogs(10, "USD", "SYP", 15000);
    expect(cogs).toBe(150000);
  });

  it("rejects bridging two non-USD currencies with a single USD-anchored rate", () => {
    expect(() => resolveSaleLineCogs(100, "EUR", "SYP", 15000)).toThrow(BusinessRuleError);
  });
});
