/**
 * Audit regression (H2) — party stats contract.
 *
 * The pure function is correct; the DEFECT was in `PartyDetails.tsx`,
 * which fed it the paginated default invoice list (`limit=20`). With more
 * than 20 invoices tenant-wide, per-party stats silently dropped invoices.
 * The fix passes the party-scoped FULL dataset
 * (`useInvoicesList({ partyId, limit: 1000 })`) and removed the
 * `Math.max(0, remaining)` clamp so credit balances (over-payment) stay
 * visible as negative remaining instead of being hidden at 0.
 *
 * These tests pin the function's math so the fix cannot regress it.
 */
import { describe, it, expect } from "vitest";
import { buildPartyStatsByCurrency } from "@/core/calculations/ledgerCalc";

const party = { id: "p1" } as any;

const inv = (n: number, currency: string, total: number) => ({
  id: `i${n}`, partyId: "p1", status: "active", type: "sale", currency,
  lines: [{ quantityKg: 1, pricePerKg: total, discountAmount: 0 }], discount: 0, tax: 0, shipping: 0,
});

describe("buildPartyStatsByCurrency — full-dataset contract (audit H2)", () => {
  it("counts every invoice, never blends currencies, even with >20 invoices", () => {
    // 25 SYP + 3 USD invoices — more than the 20-row default page
    const invoices = [
      ...Array.from({ length: 25 }, (_, i) => inv(i, "SYP", 1000)),
      ...Array.from({ length: 3 }, (_, i) => inv(100 + i, "USD", 5)),
    ];
    const stats = buildPartyStatsByCurrency(party, "customer", invoices as any, []);
    expect(stats["SYP"].invoicesCount).toBe(25);
    expect(stats["SYP"].totalAmount).toBe(25_000);
    expect(stats["USD"].invoicesCount).toBe(3);
    expect(stats["USD"].totalAmount).toBe(15);
    expect(stats["SYP"].totalAmount).not.toContain?.(15); // no blending
  });

  it("paid only counts that currency's receipts; over-payment surfaces as a NEGATIVE (credit) remaining", () => {
    const invoices = [inv(1, "SYP", 1000), inv(2, "USD", 5)];
    const vouchers = [
      { partyId: "p1", kind: "receipt", status: "active", amount: 1200, currency: "SYP" }, // overpay
      { partyId: "p1", kind: "receipt", status: "active", amount: 5, currency: "USD" },
      { partyId: "p1", kind: "payment", status: "active", amount: 999, currency: "SYP" }, // must be ignored
    ];
    const stats = buildPartyStatsByCurrency(party, "customer", invoices as any, vouchers as any);
    expect(stats["SYP"].totalPaid).toBe(1200);
    // H2 fix: the old Math.max(0, …) clamp hid the 200 credit balance.
    expect(stats["SYP"].remaining).toBe(-200);
    expect(stats["USD"].totalPaid).toBe(5);
    expect(stats["USD"].remaining).toBe(0);
  });

  it("ignores cancelled invoices and vouchers", () => {
    const invoices = [
      { ...inv(1, "SYP", 1000), status: "cancelled" },
      inv(2, "SYP", 500),
    ];
    const vouchers = [
      { partyId: "p1", kind: "receipt", status: "cancelled", amount: 100, currency: "SYP" },
    ];
    const stats = buildPartyStatsByCurrency(party, "customer", invoices as any, vouchers as any);
    expect(stats["SYP"].invoicesCount).toBe(1);
    expect(stats["SYP"].totalAmount).toBe(500);
    expect(stats["SYP"].totalPaid).toBe(0);
  });
});
