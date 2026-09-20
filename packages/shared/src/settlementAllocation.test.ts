import { describe, expect, it } from "vitest";
import {
  allocateSettlementPayment,
  settlementRequiresExchangeRate,
} from "./settlementAllocation.js";

describe("settlementRequiresExchangeRate", () => {
  it("requires rate for non-USD settlement currency", () => {
    expect(settlementRequiresExchangeRate("SYP", ["SYP"])).toBe(true);
  });
  it("requires rate when currencies differ even if settlement is USD", () => {
    expect(settlementRequiresExchangeRate("USD", ["SYP", "USD"])).toBe(true);
  });
  it("skips rate when everything is USD", () => {
    expect(settlementRequiresExchangeRate("USD", ["USD"])).toBe(false);
  });
});

describe("allocateSettlementPayment", () => {
  it("same-currency USD: no rate, full settle", () => {
    const r = allocateSettlementPayment({
      invoices: [
        { invoiceId: "a", number: "INV-1", date: "2026-01-01", currency: "USD", remaining: 100 },
        { invoiceId: "b", number: "INV-2", date: "2026-01-02", currency: "USD", remaining: 80 },
      ],
      amountPaid: 180,
      settlementCurrency: "USD",
    });
    expect(r.totalDueInSettlement).toBe(180);
    expect(r.totalAllocated).toBe(180);
    expect(r.allocations).toHaveLength(2);
  });

  it("mixed: SYP+USD settled in USD at settlement rate (not invoice historical)", () => {
    const r = allocateSettlementPayment({
      invoices: [
        {
          invoiceId: "syp",
          number: "INV-001",
          date: "2026-01-01",
          currency: "SYP",
          remaining: 1_000_000,
        },
        {
          invoiceId: "usd",
          number: "INV-002",
          date: "2026-01-02",
          currency: "USD",
          remaining: 200,
        },
      ],
      amountPaid: 300,
      settlementCurrency: "USD",
      exchangeRate: 10_000,
    });
    expect(r.totalDueInSettlement).toBe(300);
    expect(r.allocations.find((a) => a.invoiceId === "syp")?.amountInSettlementCurrency).toBe(100);
    expect(r.allocations.find((a) => a.invoiceId === "syp")?.amountInInvoiceCurrency).toBe(
      1_000_000,
    );
    expect(r.allocations.find((a) => a.invoiceId === "usd")?.amountInSettlementCurrency).toBe(200);
  });

  it("partial FIFO leaves later invoices open", () => {
    const r = allocateSettlementPayment({
      invoices: [
        { invoiceId: "a", number: "INV-1", date: "2026-01-01", currency: "USD", remaining: 100 },
        { invoiceId: "b", number: "INV-2", date: "2026-01-02", currency: "USD", remaining: 100 },
      ],
      amountPaid: 150,
      settlementCurrency: "USD",
    });
    expect(r.allocations).toHaveLength(2);
    expect(r.allocations[0]!.amountInSettlementCurrency).toBe(100);
    expect(r.allocations[0]!.remainingAfterInInvoiceCurrency).toBe(0);
    expect(r.allocations[1]!.amountInSettlementCurrency).toBe(50);
    expect(r.allocations[1]!.remainingAfterInInvoiceCurrency).toBe(50);
  });

  it("USD invoices settled in SYP", () => {
    const r = allocateSettlementPayment({
      invoices: [
        { invoiceId: "a", number: "INV-1", date: "2026-01-01", currency: "USD", remaining: 300 },
      ],
      amountPaid: 3_600_000,
      settlementCurrency: "SYP",
      exchangeRate: 12_000,
    });
    expect(r.totalDueInSettlement).toBe(3_600_000);
    expect(r.allocations[0]!.amountInInvoiceCurrency).toBe(300);
  });
});
