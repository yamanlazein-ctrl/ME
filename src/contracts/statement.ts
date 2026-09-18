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
    Record<Currency, { previousBalance: number; totalDebit: number; totalCredit: number; finalBalance: number }>
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
