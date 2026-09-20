/**
 * Phase 1 — invoice ledger legs stay balanced in document + base currency.
 * Mirrors PostgresInvoiceRepository.invoiceLedgerLegs without DB I/O.
 */
import { describe, expect, it } from "vitest";
import { computeBaseEquivalent, BASE_CURRENCY } from "@erp/shared";

type Leg = {
  debit: number;
  credit: number;
  currency: string;
  baseDebit: number | null;
  baseCredit: number | null;
  type: string;
};

function invoiceLedgerLegs(args: {
  isSale: boolean;
  total: number;
  cogsTotal: number;
  currency: string;
  fxRate: number | null;
}): Leg[] {
  const legFx = (debit: number, credit: number) => ({
    exchangeRate: args.fxRate,
    baseDebit: computeBaseEquivalent(debit, args.currency, args.fxRate),
    baseCredit: computeBaseEquivalent(credit, args.currency, args.fxRate),
  });
  const invoiceType = args.isSale ? "sales_invoice" : "purchase_invoice";
  const legs: Leg[] = [
    {
      ...legFx(args.isSale ? args.total : 0, args.isSale ? 0 : args.total),
      type: invoiceType,
      debit: args.isSale ? args.total : 0,
      credit: args.isSale ? 0 : args.total,
      currency: args.currency,
    },
  ];
  if (args.isSale) {
    legs.push({
      ...legFx(0, args.total),
      type: "sales_revenue",
      debit: 0,
      credit: args.total,
      currency: args.currency,
    });
    if (args.cogsTotal > 0) {
      legs.push({
        ...legFx(args.cogsTotal, 0),
        type: "cogs_expense",
        debit: args.cogsTotal,
        credit: 0,
        currency: args.currency,
      });
      legs.push({
        ...legFx(0, args.cogsTotal),
        type: "inventory_asset",
        debit: 0,
        credit: args.cogsTotal,
        currency: args.currency,
      });
    }
  } else {
    legs.push({
      ...legFx(args.total, 0),
      type: "inventory_asset",
      debit: args.total,
      credit: 0,
      currency: args.currency,
    });
  }
  return legs;
}

describe("invoiceLedgerLegs balance (Phase 1)", () => {
  it("sale + COGS: raw and base debit == credit", () => {
    const legs = invoiceLedgerLegs({
      isSale: true,
      total: 1000,
      cogsTotal: 400,
      currency: "SYP",
      fxRate: 15000,
    });
    const debit = legs.reduce((s, l) => s + l.debit, 0);
    const credit = legs.reduce((s, l) => s + l.credit, 0);
    const baseDebit = legs.reduce((s, l) => s + (l.baseDebit ?? 0), 0);
    const baseCredit = legs.reduce((s, l) => s + (l.baseCredit ?? 0), 0);
    expect(debit).toBe(credit);
    expect(baseDebit).toBeCloseTo(baseCredit, 6);
    expect(legs.map((l) => l.type).sort()).toEqual(
      ["cogs_expense", "inventory_asset", "sales_invoice", "sales_revenue"].sort(),
    );
  });

  it("purchase: inventory + AP balanced in USD base", () => {
    const legs = invoiceLedgerLegs({
      isSale: false,
      total: 250,
      cogsTotal: 0,
      currency: BASE_CURRENCY,
      fxRate: 1,
    });
    const debit = legs.reduce((s, l) => s + l.debit, 0);
    const credit = legs.reduce((s, l) => s + l.credit, 0);
    expect(debit).toBe(250);
    expect(credit).toBe(250);
    expect(debit).toBe(credit);
  });
});
