import type { EndpointMeta, ApiError } from "./_shared";
import type { UUID, Currency, LedgerType } from "@/domain/types";
import type { PartyKind } from "@/domain/entities/Party";

/** One expandable line inside a statement row (typically an invoice). */
export interface StatementLineDTO {
  lineId: UUID;
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
 * The original document behind a statement row, as entered. For a payment made
 * in another currency than the invoice it settles, `debit`/`credit` on the row
 * is the CONVERTED equivalent (in the row's currency) while this carries the
 * payment's own currency/amount and the rate captured at payment time.
 */
export interface StatementDocumentDTO {
  kind: "invoice" | "voucher";
  number: string;
  currency: Currency | string;
  amount: number;
  /** Units of `currency` per 1 USD, frozen on the document. Null when none applied. */
  exchangeRate: number | null;
  discount?: number;
  method?: string;
  appliedToInvoiceNumber?: string;
  appliedToInvoiceCurrency?: Currency | string;
  crossCurrency?: boolean;
  /** Customer receipts: part kept as customer credit (on-account or overpaid excess). */
  advanceAmount?: number;
  /** Invoices: amount paid so far (cash + credit). */
  paid?: number;
  /** Invoices: part settled from the customer's credit balance. */
  creditApplied?: number;
}

/** One statement row with its running balance already computed server-side. */
export interface StatementEntryDTO {
  id: UUID;
  seq: number;
  date: string;
  type: LedgerType;
  /** Cancelled movements are shown (struck through) but excluded from balances. */
  status: "active" | "cancelled";
  /** Ledger currency for this row (always present; needed for multi-currency statements). */
  currency?: Currency;
  referenceType?: string;
  referenceId?: UUID;
  referenceNumber?: string;
  description?: string;
  quantityKg?: number;
  pricePerKg?: number;
  debit: number;
  credit: number;
  runningBalance: number;
  lines?: StatementLineDTO[];
  document?: StatementDocumentDTO;
}

/** Full party statement (كشف حساب). */
export interface PartyStatementDTO {
  partyId: UUID;
  partyName: string;
  partyCode?: string | null;
  kind: PartyKind;
  /** Filter currency, or `"ALL"` when every ledger currency is included. */
  currency: Currency | "ALL";
  fromDate?: string | null;
  toDate?: string | null;
  type?: string | null;
  previousBalance: number;
  totalDebit: number;
  totalCredit: number;
  finalBalance: number;
  totalsByCurrency?: Partial<
    Record<
      Currency,
      {
        previousBalance: number;
        totalDebit: number;
        totalCredit: number;
        finalBalance: number;
        /** Which side the final balance is on (مدين / دائن). */
        balanceSide?: "debit" | "credit" | "zero";
        /** Customers: spendable credit (advance payments not yet used). */
        availableCredit?: number;
      }
    >
  >;
  entries: StatementEntryDTO[];
}

export interface StatementFilter {
  from?: string;
  to?: string;
  currency?: Currency | "ALL";
  type?: LedgerType;
}

export interface SettleResponse {
  entry: {
    id: UUID;
    date: string;
    type: LedgerType;
    debit: number;
    credit: number;
    currency: Currency;
    referenceNumber?: string;
    description?: string;
  };
  referenceNumber: string;
  kind: PartyKind;
}

export interface SettleInput {
  date?: string;
  currency?: Currency;
  notesInternal?: string;
}

/** One line in a multi-invoice cash settlement batch. */
export interface SettleInvoicesAllocationDTO {
  invoiceId: UUID;
  invoiceNumber: string;
  invoiceCurrency: Currency | string;
  remainingBefore: number;
  amountInSettlementCurrency: number;
  amountInInvoiceCurrency: number;
  remainingAfter: number;
  voucherId: UUID;
  voucherNumber: string;
}

export interface SettleInvoicesInput {
  invoiceIds: UUID[];
  amountPaid: number;
  discount?: number;
  currency: Currency;
  exchangeRate?: number;
  date?: string;
  method?: "cash" | "transfer" | "check" | "card";
  notesInternal?: string;
  notesPrint?: string;
}

export interface SettleInvoicesResponse {
  batchNumber: string;
  currency: Currency | string;
  exchangeRate: number | null;
  amountPaid: number;
  /** Customer surplus above the total due, booked as an on-account receipt (credit). */
  advance?: { amount: number; voucherId: UUID; voucherNumber: string } | null;
  totalDueInSettlement: number;
  totalAllocated: number;
  date: string;
  method: string;
  allocations: SettleInvoicesAllocationDTO[];
  vouchers: Array<{
    id: UUID;
    number: string;
    amount: number;
    currency: string;
    invoiceId?: UUID;
  }>;
}

export type GetCustomerStatementResponse = PartyStatementDTO;
export type GetCustomerStatementError = ApiError;
export const GetCustomerStatementEndpoint: EndpointMeta = {
  path: "/api/customers/:id/statement",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant", "warehouse", "viewer"] },
  description: "Customer statement of account with previous balance, running balance and totals",
};

export const GetSupplierStatementEndpoint: EndpointMeta = {
  path: "/api/suppliers/:id/statement",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant", "warehouse", "viewer"] },
  description: "Supplier statement of account with previous balance, running balance and totals",
};

export type SettleCustomerResponse = SettleResponse;
export type SettleCustomerError = ApiError;
export const SettleCustomerEndpoint: EndpointMeta = {
  path: "/api/customers/:id/statement/settle",
  method: "POST",
  auth: { required: true, roles: ["admin", "accountant"] },
  description: "Zero a customer's balance via a settlement entry",
};

export const SettleSupplierEndpoint: EndpointMeta = {
  path: "/api/suppliers/:id/statement/settle",
  method: "POST",
  auth: { required: true, roles: ["admin", "accountant"] },
  description: "Zero a supplier's balance via a settlement entry",
};

export const SettleCustomerInvoicesEndpoint: EndpointMeta = {
  path: "/api/customers/:id/statement/settle-invoices",
  method: "POST",
  auth: { required: true, roles: ["admin", "accountant"] },
  description: "Cash-settle selected open invoices in one settlement batch",
};

export const SettleSupplierInvoicesEndpoint: EndpointMeta = {
  path: "/api/suppliers/:id/statement/settle-invoices",
  method: "POST",
  auth: { required: true, roles: ["admin", "accountant"] },
  description: "Cash-settle selected open invoices in one settlement batch",
};
