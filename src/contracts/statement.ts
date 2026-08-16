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
  currency: Currency;
  fromDate?: string | null;
  toDate?: string | null;
  type?: string | null;
  previousBalance: number;
  totalDebit: number;
  totalCredit: number;
  finalBalance: number;
  entries: StatementEntryDTO[];
}

export interface StatementFilter {
  from?: string;
  to?: string;
  currency?: Currency;
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
