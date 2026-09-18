import { describe, it, expect } from "vitest";
import { parseVoucherNewSearch } from "./voucherNewSearch";

/**
 * Regression test for F14 (Phase 1 foundation audit): "payment voucher from
 * a cancelled invoice opens an empty /payments/new". Root cause was that
 * `invoiceId` did not exist as a recognized search param on /payments/new
 * or /receipts/new at all — a link passing `invoiceId` had it silently
 * dropped before the form ever saw it. This test would FAIL before the fix
 * (the old parser only recognized `partyId`/`edit`).
 */
describe("parseVoucherNewSearch (F14 regression)", () => {
  it("parses invoiceId from the search params", () => {
    const result = parseVoucherNewSearch({
      partyId: "party-1",
      invoiceId: "invoice-1",
    });
    expect(result.invoiceId).toBe("invoice-1");
    expect(result.partyId).toBe("party-1");
  });

  it("leaves invoiceId undefined when absent", () => {
    const result = parseVoucherNewSearch({ partyId: "party-1" });
    expect(result.invoiceId).toBeUndefined();
  });

  it("ignores a non-string invoiceId instead of throwing", () => {
    const result = parseVoucherNewSearch({ invoiceId: 12345 });
    expect(result.invoiceId).toBeUndefined();
  });

  it("still parses partyId and edit as before", () => {
    const result = parseVoucherNewSearch({ partyId: "p1", edit: "v1" });
    expect(result).toEqual({ partyId: "p1", invoiceId: undefined, edit: "v1" });
  });
});
