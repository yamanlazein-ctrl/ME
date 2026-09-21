import type { UUID, LedgerType, PartyKind } from "../types/index.js";

/**
 * A single expandable line inside a statement row (typically an invoice).
 */
export interface StatementLineDetail {
  fabricId: UUID;
  fabricName: string;
  colorId: UUID;
  colorName: string;
  rollId: UUID;
  rollNo?: string | null;
  quantityKg: number;
  pricePerKg: number;
  amount: number;
}

/**
 * The original document behind a statement row, exactly as it was entered.
 *
 * `debit`/`credit` on the row are the party sub-ledger figures (always in the
 * row's `currency`). When a payment is made in another currency than the
 * invoice it settles, the row figure is the CONVERTED equivalent while this
 * block carries the payment's own currency, amount and the rate captured at
 * payment time. Invoices carry their own frozen historical rate. Nothing here
 * is ever re-valued at a later rate.
 */
export interface StatementDocumentInfo {
  kind: "invoice" | "voucher";
  number: string;
  /** Currency the document was entered in. */
  currency: string;
  /** Gross amount in `currency`. */
  amount: number;
  /** Rate frozen on the document (units of `currency` per 1 USD); null when unknown. */
  exchangeRate: number | null;
  /** Vouchers: settlement discount in `currency` (cash concession). */
  discount?: number;
  method?: string;
  /** Vouchers: the invoice this payment was applied to, when linked. */
  appliedToInvoiceNumber?: string;
  appliedToInvoiceCurrency?: string;
  /** Vouchers: payment currency differs from the currency of the row (the invoice). */
  crossCurrency?: boolean;
}

/**
 * One statement row. Entries are chronological (date ASC, createdAt ASC) and
 * each row carries its running balance so the UI never has to re-accumulate.
 *
 * Cancelled movements (`status = "cancelled"`) are always present in the
 * register (they must never be dropped from the query) but they are excluded
 * from previousBalance/runningBalance/totals. The UI strikes them through.
 */
export interface StatementEntryData {
  id: UUID;
  seq: number;
  date: string;
  type: LedgerType;
  status: "active" | "cancelled";
  /** Ledger row currency — always set; critical when the statement is multi-currency. */
  currency: string;
  referenceType?: string;
  referenceId?: UUID;
  referenceNumber?: string;
  description?: string;
  quantityKg?: number;
  pricePerKg?: number;
  debit: number;
  credit: number;
  runningBalance: number;
  lines?: StatementLineDetail[];
  document?: StatementDocumentInfo;
}

/**
 * Full party statement: header party metadata + filters echo + totals.
 * previousBalance: sum of signed movements strictly before fromDate.
 * finalBalance: previousBalance + (totalDebit − totalCredit) for a customer,
 * or previousBalance + (totalCredit − totalDebit) for a supplier.
 */
export interface PartyStatementData {
  partyId: UUID;
  partyName: string;
  partyCode?: string | null;
  kind: PartyKind;
  /** Selected filter currency, or `"ALL"` when every ledger currency is included. */
  currency: string;
  fromDate?: string | null;
  toDate?: string | null;
  type?: string | null;
  previousBalance: number;
  totalDebit: number;
  totalCredit: number;
  finalBalance: number;
  /** Per-currency totals — populated when `currency === "ALL"`, else a single-key map. */
  totalsByCurrency?: Record<
    string,
    { previousBalance: number; totalDebit: number; totalCredit: number; finalBalance: number }
  >;
  entries: StatementEntryData[];
}

export interface StatementQuery {
  partyId: UUID;
  kind: PartyKind;
  fromDate?: string;
  toDate?: string;
  currency?: string;
  type?: string;
}
