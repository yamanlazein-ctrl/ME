import { describe, expect, it } from "vitest";
import type { StatementDocumentDTO } from "@/contracts/statement";
import {
  statementOriginalAmount,
  statementPaymentNote,
  statementRateToShow,
} from "./statementDocument";

const usdReceipt: StatementDocumentDTO = {
  kind: "voucher",
  number: "VOC-1",
  currency: "USD",
  amount: 10,
  exchangeRate: 136.5,
  discount: 0,
  appliedToInvoiceNumber: "INV-1",
  appliedToInvoiceCurrency: "SYP",
  crossCurrency: true,
};

describe("statementDocument", () => {
  it("shows the payment-time rate only when the payment converted", () => {
    expect(statementRateToShow(usdReceipt)).toBe(136.5);
    expect(statementRateToShow({ ...usdReceipt, crossCurrency: false })).toBeNull();
  });

  it("shows an invoice's frozen rate except for USD", () => {
    const inv: StatementDocumentDTO = {
      kind: "invoice",
      number: "INV-1",
      currency: "SYP",
      amount: 1365,
      exchangeRate: 130,
    };
    expect(statementRateToShow(inv)).toBe(130);
    expect(statementRateToShow({ ...inv, currency: "USD", exchangeRate: 1 })).toBeNull();
  });

  it("renders the original amount in its own currency", () => {
    expect(statementOriginalAmount(usdReceipt)).toMatch(/10 \$/);
  });

  it("explains a cross-currency payment with rate, equivalent and target invoice", () => {
    const note = statementPaymentNote(usdReceipt, "SYP", 1365)!;
    expect(note).toContain("× 136.5");
    expect(note).toContain("1,365 ل.س");
    expect(note).toContain("INV-1");
  });

  it("marks an unlinked payment as on-account", () => {
    const { appliedToInvoiceNumber: _a, ...rest } = usdReceipt;
    expect(statementPaymentNote({ ...rest, crossCurrency: false }, "USD", 10)).toBe(
      "دفعة على الحساب",
    );
  });
});
