import type { StatementDocumentDTO } from "@/contracts/statement";
import { formatMoney } from "@/shared/utils/formatNumber";

const SYMBOL: Record<string, string> = { SYP: "ل.س", USD: "$", EUR: "€" };
const sym = (c: string) => SYMBOL[c] ?? c;

/**
 * Exchange rate worth showing on a statement row, or null.
 * - Payment: only when it actually converted (paid in another currency than the
 *   invoice it settles) — the rate captured at payment time.
 * - Invoice: its frozen historical rate, except for USD (rate is trivially 1).
 */
export function statementRateToShow(doc?: StatementDocumentDTO): number | null {
  if (!doc || !doc.exchangeRate || doc.exchangeRate <= 0) return null;
  if (doc.kind === "voucher") return doc.crossCurrency ? doc.exchangeRate : null;
  return doc.currency === "USD" ? null : doc.exchangeRate;
}

/** "10 $" — the document amount in the currency it was entered in. */
export function statementOriginalAmount(doc?: StatementDocumentDTO): string | null {
  if (!doc) return null;
  return `${formatMoney(doc.amount)} ${sym(doc.currency)}`;
}

/**
 * One line explaining how a payment hit the account, e.g.
 * "10 $ × 136.5 = 1,365 ل.س · مطبّقة على الفاتورة INV-2026-1503".
 * `equivalent` is the row's own debit/credit (the converted amount in the row currency).
 */
export function statementPaymentNote(
  doc: StatementDocumentDTO | undefined,
  rowCurrency: string,
  equivalent: number,
): string | null {
  if (!doc || doc.kind !== "voucher") return null;
  const parts: string[] = [];
  if (doc.crossCurrency && doc.exchangeRate) {
    // LRI…PDI keeps the equation left-to-right inside the RTL Arabic line.
    parts.push(
      `⁦${formatMoney(doc.amount)} ${sym(doc.currency)} × ${formatMoney(doc.exchangeRate)} = ${formatMoney(equivalent)} ${sym(rowCurrency)}⁩`,
    );
  }
  if (doc.discount && doc.discount > 0) {
    parts.push(`خصم ${formatMoney(doc.discount)} ${sym(doc.currency)}`);
  }
  if (doc.appliedToInvoiceNumber) {
    parts.push(`مطبّقة على الفاتورة ${doc.appliedToInvoiceNumber}`);
  } else {
    parts.push("دفعة على الحساب");
  }
  return parts.join(" · ");
}
