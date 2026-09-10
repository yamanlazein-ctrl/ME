/**
 * Live verification for the cross-currency "counterpart" line on the printed
 * voucher (step 4 of the multi-currency work).
 *
 * Renders the REAL VoucherPrintDocument through Vite's transform pipeline —
 * no reimplementation — and asserts a 100 USD receipt against a SYP invoice
 * at 132 prints "13,200 ل.س بسعر صرف 132", while a same-currency voucher
 * prints no counterpart at all.
 *
 * The counterpart is computed from the RATE ENTERED ON THE VOUCHER
 * (`exchangeRate`), never `invoiceExchangeRate` — using the invoice's own
 * frozen rate here silently ignored whatever the user actually typed
 * whenever the voucher's own currency was USD, and settled against a stale
 * rate instead (see `convertForSettlement` in `packages/shared/src/fx.ts`).
 * Fixtures below set `exchangeRate` to whatever the user would have entered.
 */
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import { Voucher } from "@/domain/entities/Voucher";

vi.mock("@/presentation/hooks/useParties", () => ({
  customerById: () => ({ id: "c1", name: "عميل اختبار", code: "C-1" }),
  supplierById: () => ({ id: "s1", name: "مورد اختبار", code: "S-1" }),
}));

const { VoucherPrintDocument } = await import("./VoucherPrintDocument");

type ReceiptProps = Parameters<typeof Voucher.receipt>[0];

function makeVoucher(over: Partial<ReceiptProps>): Voucher {
  return Voucher.receipt({
    id: "v1",
    tenantId: "t1",
    number: "VOC-2026-0001",
    date: "2026-08-30",
    partyId: "c1",
    partyKind: "customer",
    invoiceId: "inv1",
    amount: 100,
    currency: "USD",
    exchangeRate: null,
    method: "cash",
    ...over,
  });
}

const render = (v: Voucher) =>
  renderToString(React.createElement(VoucherPrintDocument, { voucher: v }));

describe("VoucherPrintDocument cross-currency counterpart", () => {
  it("prints the counterpart in the invoice currency when currencies differ", () => {
    // 100 USD x 132 SYP/USD = 13,200 SYP — 132 is the rate entered ON THIS
    // VOUCHER; invoiceExchangeRate is deliberately a different value here to
    // prove the printed counterpart follows the voucher's own rate, not it.
    const html = render(
      makeVoucher({ exchangeRate: 132, invoiceCurrency: "SYP", invoiceExchangeRate: 999 }),
    );
    expect(html).toContain("المقابل");
    expect(html).toContain("13,200");
    expect(html).toContain("ل.س");
    expect(html).toContain("بسعر صرف 132");
    // the original amount must still be shown in the voucher's own currency
    expect(html).toContain("100");
  });

  it("prints no counterpart line when the currencies match", () => {
    const html = render(
      makeVoucher({
        currency: "SYP",
        exchangeRate: 132,
        invoiceCurrency: "SYP",
        invoiceExchangeRate: 132,
      }),
    );
    expect(html).not.toContain("المقابل");
  });

  it("prints no counterpart line for a standalone payment (no linked invoice)", () => {
    const html = render(makeVoucher({ invoiceId: null }));
    expect(html).not.toContain("المقابل");
  });

  it("prints no counterpart line when the voucher itself has no usable rate", () => {
    // invoiceExchangeRate is irrelevant to the counterpart now — only the
    // voucher's own (unset here) rate is.
    const html = render(
      makeVoucher({ invoiceCurrency: "SYP", invoiceExchangeRate: 132 }),
    );
    expect(html).not.toContain("المقابل");
  });
});
