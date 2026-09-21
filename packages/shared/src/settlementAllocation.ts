/**
 * Multi-invoice account settlement allocation.
 *
 * Converts each invoice's remaining balance into the chosen settlement
 * currency using the settlement's OWN rate (`convertForSettlement`), then
 * allocates a cash payment FIFO (oldest invoice first). Invoice historical
 * FX rates are never consulted here — they stay frozen on the invoice.
 */

import { convertForSettlement, FX_REQUIRED_MESSAGE, isValidFxRate } from "./fx.js";
import { round2dp } from "./precision.js";

export type SettlementInvoiceInput = {
  invoiceId: string;
  number?: string;
  date?: string;
  currency: string;
  /** Remaining balance in the invoice's own currency. */
  remaining: number;
};

export type SettlementAllocationLine = {
  invoiceId: string;
  number?: string;
  date?: string;
  invoiceCurrency: string;
  remainingBefore: number;
  /** Amount of the settlement payment applied to this invoice (settlement ccy). */
  amountInSettlementCurrency: number;
  /** Counterpart in the invoice currency (what advances invoices.paid). */
  amountInInvoiceCurrency: number;
  remainingAfterInInvoiceCurrency: number;
};

export type AllocateSettlementResult = {
  allocations: SettlementAllocationLine[];
  totalDueInSettlement: number;
  totalAllocated: number;
};

/** True when a settlement rate is required for conversion and/or voucher base. */
export function settlementRequiresExchangeRate(
  settlementCurrency: string,
  invoiceCurrencies: string[],
): boolean {
  if (settlementCurrency !== "USD") return true;
  return invoiceCurrencies.some((c) => c !== settlementCurrency);
}

/**
 * Allocate `amountPaid` (settlement currency) across open invoices FIFO.
 * Throws Error with an Arabic message when FX conversion is impossible.
 */
export function allocateSettlementPayment(opts: {
  invoices: SettlementInvoiceInput[];
  amountPaid: number;
  settlementCurrency: string;
  exchangeRate?: number | null;
}): AllocateSettlementResult {
  const amountPaid = round2dp(opts.amountPaid);
  if (!(amountPaid > 0)) {
    throw new Error("مبلغ الدفعة يجب أن يكون أكبر من صفر");
  }

  const sorted = [...opts.invoices]
    .filter((i) => i.remaining > 0)
    .sort((a, b) => {
      const d = (a.date ?? "").localeCompare(b.date ?? "");
      if (d !== 0) return d;
      return (a.number ?? a.invoiceId).localeCompare(b.number ?? b.invoiceId);
    });

  if (sorted.length === 0) {
    throw new Error("لا توجد فواتير مفتوحة للسداد");
  }

  const needsRate = settlementRequiresExchangeRate(
    opts.settlementCurrency,
    sorted.map((i) => i.currency),
  );
  const rate = isValidFxRate(opts.exchangeRate) ? opts.exchangeRate : null;
  if (needsRate && rate === null) {
    throw new Error(FX_REQUIRED_MESSAGE);
  }

  const withDue = sorted.map((inv) => {
    const due = convertForSettlement(inv.remaining, inv.currency, opts.settlementCurrency, rate);
    if (due === null) {
      throw new Error(
        `لا يمكن تحويل فاتورة ${inv.number ?? inv.invoiceId} من ${inv.currency} إلى ${opts.settlementCurrency} — ${FX_REQUIRED_MESSAGE}`,
      );
    }
    return { inv, dueInSettlement: due };
  });

  const totalDueInSettlement = round2dp(withDue.reduce((s, x) => s + x.dueInSettlement, 0));
  let left = round2dp(Math.min(amountPaid, totalDueInSettlement));
  const allocations: SettlementAllocationLine[] = [];

  for (const { inv, dueInSettlement } of withDue) {
    if (left <= 0) break;
    const take = round2dp(Math.min(dueInSettlement, left));
    if (take <= 0) continue;

    const inInvoice = convertForSettlement(take, opts.settlementCurrency, inv.currency, rate);
    if (inInvoice === null) {
      throw new Error(
        `لا يمكن تحويل مبلغ الدفعة إلى عملة الفاتورة ${inv.currency} — ${FX_REQUIRED_MESSAGE}`,
      );
    }
    // Cap at remaining so voucher create's over-collection guard never trips on 0.01.
    // A `take` that covers this invoice's full due (remaining restated in the
    // settlement currency) closes it EXACTLY — converting `take` back would drift
    // by the settlement currency's rounding quantum (USD→SYP→USD residual).
    const closesInvoice = take === dueInSettlement;
    const amountInInvoiceCurrency = closesInvoice
      ? round2dp(inv.remaining)
      : round2dp(Math.min(inInvoice, inv.remaining));
    // If we capped the invoice side, restate settlement amount from that (same-currency noop).
    let amountInSettlementCurrency = take;
    if (!closesInvoice && Math.abs(amountInInvoiceCurrency - inInvoice) >= 0.01) {
      const restated = convertForSettlement(
        amountInInvoiceCurrency,
        inv.currency,
        opts.settlementCurrency,
        rate,
      );
      if (restated === null) {
        throw new Error(FX_REQUIRED_MESSAGE);
      }
      amountInSettlementCurrency = restated;
    }

    allocations.push({
      invoiceId: inv.invoiceId,
      number: inv.number,
      date: inv.date,
      invoiceCurrency: inv.currency,
      remainingBefore: inv.remaining,
      amountInSettlementCurrency,
      amountInInvoiceCurrency,
      remainingAfterInInvoiceCurrency: round2dp(
        Math.max(0, inv.remaining - amountInInvoiceCurrency),
      ),
    });
    left = round2dp(left - amountInSettlementCurrency);
  }

  const totalAllocated = round2dp(
    allocations.reduce((s, a) => s + a.amountInSettlementCurrency, 0),
  );
  if (totalAllocated <= 0) {
    throw new Error("تعذّر توزيع مبلغ الدفعة على الفواتير");
  }

  return { allocations, totalDueInSettlement, totalAllocated };
}
