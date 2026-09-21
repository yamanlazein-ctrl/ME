import { describe, expect, it } from "vitest";
import { settleAmountAgainstRemaining } from "@erp/shared";
import { allocateSettlementPayment } from "@erp/shared";
import { round2dp } from "@erp/shared";

describe("settleAmountAgainstRemaining — exact closure", () => {
  it("10 USD at 136,500 SYP/USD settles a 1,365,000 SYP invoice exactly", () => {
    expect(settleAmountAgainstRemaining(10, "USD", "SYP", 136500, 1_365_000)).toBe(1_365_000);
  });

  it("partial payments convert plainly (no forced closure)", () => {
    expect(settleAmountAgainstRemaining(5, "USD", "SYP", 136500, 1_365_000)).toBe(682_500);
  });

  it("the cent-rounded exact USD amount closes an uneven SYP balance to exactly 0", () => {
    // 1,000,000 / 13,500 = 74.0740… → 74.07 is the closest payable amount.
    expect(settleAmountAgainstRemaining(74.07, "USD", "SYP", 13500, 1_000_000)).toBe(1_000_000);
  });

  it("a genuinely short or excessive payment is NOT rounded to full", () => {
    expect(settleAmountAgainstRemaining(74.0, "USD", "SYP", 13500, 1_000_000)).toBe(999_000);
    expect(settleAmountAgainstRemaining(74.08, "USD", "SYP", 13500, 1_000_000)).toBe(1_000_080);
  });

  it("SYP payment against a USD invoice closes exactly", () => {
    expect(settleAmountAgainstRemaining(1_000_000, "SYP", "USD", 13500, 74.07)).toBe(74.07);
  });

  it("same currency is the ordinary comparison; missing rate → null", () => {
    expect(settleAmountAgainstRemaining(250.5, "SYP", "SYP", null, 250.5)).toBe(250.5);
    expect(settleAmountAgainstRemaining(10, "USD", "SYP", null, 100)).toBeNull();
  });

  it("closes every invoice paid with the cent-rounded exact amount (no residual, any rate)", () => {
    const rates = [9875, 11111, 12345, 12777, 13333, 13500, 14250, 14999, 15123, 16000, 136500];
    const totals = [733333, 987654, 1000000, 1234567, 2222222, 3000001, 4321000, 555555, 999999];
    for (const rate of rates) {
      for (const total of totals) {
        const pay = round2dp(total / rate);
        expect(settleAmountAgainstRemaining(pay, "USD", "SYP", rate, total)).toBe(total);
      }
    }
  });
});

describe("allocateSettlementPayment — full payment leaves exactly 0", () => {
  it("USD payment covering a SYP invoice closes it with no USD→SYP→USD drift", () => {
    const r = allocateSettlementPayment({
      invoices: [
        {
          invoiceId: "a",
          number: "INV-1",
          date: "2026-01-01",
          currency: "SYP",
          remaining: 1_000_000,
        },
      ],
      amountPaid: 74.07,
      settlementCurrency: "USD",
      exchangeRate: 13500,
    });
    expect(r.allocations[0].amountInInvoiceCurrency).toBe(1_000_000);
    expect(r.allocations[0].remainingAfterInInvoiceCurrency).toBe(0);
  });
});
