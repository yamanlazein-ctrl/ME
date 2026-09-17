import { describe, it, expect } from "vitest";
import {
  aggregatePartyListStats,
  type PartyInvoiceStatsRow,
} from "@/infrastructure/repositories/partyListStatsAggregation";

/**
 * Regression test for F09 (Phase 1 foundation audit): the customer/supplier
 * list endpoint silently dropped a party's non-default-currency invoices
 * from the "Total Sales" total and — a second, related bug found while
 * fixing this — from the invoice count too.
 *
 * Scenario from the audit: a customer with a default currency of SYP has
 * several SYP invoices and one USD invoice. Before the fix, `totalAmount`
 * and `invoicesCount` only reflected the SYP invoices — the USD invoice
 * was invisible in the list view's scalar fields, while the detail view
 * (a different code path) correctly showed both currencies.
 */
describe("aggregatePartyListStats (F09 regression)", () => {
  const party = "party-1";

  const rows: PartyInvoiceStatsRow[] = [
    // Two SYP invoices (the party's default currency).
    {
      partyId: party,
      partyCurrency: "SYP",
      currency: "SYP",
      cnt: 2,
      total: 500_000,
      paid: 200_000,
      lastDate: "2026-09-10",
    },
    // One USD invoice — previously invisible in the scalar fields.
    {
      partyId: party,
      partyCurrency: "SYP",
      currency: "USD",
      cnt: 1,
      total: 100,
      paid: 40,
      lastDate: "2026-09-15",
    },
  ];

  it("sums invoicesCount across every currency, not just the default one", () => {
    const stats = aggregatePartyListStats(rows).get(party)!;
    // Before the fix this was 2 (SYP only) — the USD invoice was dropped.
    expect(stats.invoicesCount).toBe(3);
  });

  it("keeps the money scalars (totalAmount/totalPaid/remaining) on the default currency only", () => {
    const stats = aggregatePartyListStats(rows).get(party)!;
    // Must NOT silently merge 500,000 SYP + 100 USD into one number —
    // that would violate the "currency must never be silently merged" rule.
    expect(stats.totalAmount).toBe(500_000);
    expect(stats.totalPaid).toBe(200_000);
    expect(stats.remaining).toBe(300_000);
  });

  it("exposes every currency's own totals via byCurrency, unaffected by the scalar scoping", () => {
    const stats = aggregatePartyListStats(rows).get(party)!;
    expect(stats.byCurrency?.SYP).toEqual({
      invoicesCount: 2,
      totalAmount: 500_000,
      totalPaid: 200_000,
      remaining: 300_000,
    });
    expect(stats.byCurrency?.USD).toEqual({
      invoicesCount: 1,
      totalAmount: 100,
      totalPaid: 40,
      remaining: 60,
    });
  });

  it("falls back to the sole foreign currency's totals when the party has NO default-currency invoices", () => {
    const foreignOnly: PartyInvoiceStatsRow[] = [
      {
        partyId: party,
        partyCurrency: "SYP",
        currency: "USD",
        cnt: 3,
        total: 300,
        paid: 100,
        lastDate: "2026-09-12",
      },
    ];
    const stats = aggregatePartyListStats(foreignOnly).get(party)!;
    expect(stats.invoicesCount).toBe(3);
    expect(stats.totalAmount).toBe(300);
    expect(stats.totalPaid).toBe(100);
    expect(stats.remaining).toBe(200);
  });

  it("does not fall back to a foreign currency when a real default-currency invoice sums to zero", () => {
    // A fully-refunded/zero-value default-currency document must not be
    // mistaken for "no default-currency invoices exist" and overwritten by
    // the foreign-currency fallback.
    const zeroDefault: PartyInvoiceStatsRow[] = [
      {
        partyId: party,
        partyCurrency: "SYP",
        currency: "SYP",
        cnt: 1,
        total: 0,
        paid: 0,
        lastDate: "2026-09-11",
      },
      {
        partyId: party,
        partyCurrency: "SYP",
        currency: "USD",
        cnt: 1,
        total: 100,
        paid: 0,
        lastDate: "2026-09-12",
      },
    ];
    const stats = aggregatePartyListStats(zeroDefault).get(party)!;
    expect(stats.totalAmount).toBe(0);
    expect(stats.totalPaid).toBe(0);
    expect(stats.invoicesCount).toBe(2);
  });

  it("tracks the most recent invoice date across every currency", () => {
    const stats = aggregatePartyListStats(rows).get(party)!;
    expect(stats.lastDate).toBe("2026-09-15"); // the USD invoice, not the SYP ones
  });
});
