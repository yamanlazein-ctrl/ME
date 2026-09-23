/**
 * Core domain types shared across all bounded contexts.
 * These are primitive aliases and common DTO shapes.
 */

export type UUID = string;

export interface TenantContext {
  tenantId: UUID;
  userId: UUID;
  userRole: "admin" | "accountant" | "warehouse" | "viewer";
  userName: string;
}

export type Timestamp = string; // ISO 8601

export interface PaginatedResult<T> {
  data: T[];
  total: number;
  hasNext: boolean;
  nextCursor?: string;
}

export interface PaginationParams {
  limit?: number;
  cursor?: string;
}

export interface MoneyInput {
  amount: number;
  currency: Currency;
}

export interface MoneyData {
  amount: number;
  currency: Currency;
}

export type Currency = "SYP" | "USD" | "EUR";

export type EntityStatus = "active" | "cancelled" | "draft";

export type InvoiceType = "entry" | "sale";

export type VoucherKind = "receipt" | "payment";
export type VoucherMethod = "cash" | "transfer" | "check" | "card";

/** Utility to strip readonly from all fields of a type. */
export type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export type LedgerType =
  | "adjustment"
  | "adjustment_contra"
  | "cancellation"
  | "cash"
  | "cogs_expense"
  | "expense"
  | "inventory_asset"
  | "opening"
  | "opening_equity"
  | "payment_out"
  | "printing_charge"
  | "printing_revenue"
  | "purchase_invoice"
  | "purchase_return"
  | "purchase_return_contra"
  | "receipt_in"
  | "sales_invoice"
  | "sales_revenue"
  | "sales_return"
  | "sales_return_contra"
  | "settlement"
  | "settlement_contra"
  | "settlement_discount_expense"
  | "settlement_discount_income"
  | "fx_gain"
  | "fx_loss";

/** Must stay equal to backend `LEDGER_ENTRY_TYPES` (REPAIR-011). */
export const FRONTEND_LEDGER_TYPES: readonly LedgerType[] = [
  "adjustment",
  "adjustment_contra",
  "cancellation",
  "cash",
  "cogs_expense",
  "expense",
  "inventory_asset",
  "opening",
  "opening_equity",
  "payment_out",
  "printing_charge",
  "printing_revenue",
  "purchase_invoice",
  "purchase_return",
  "purchase_return_contra",
  "receipt_in",
  "sales_invoice",
  "sales_revenue",
  "sales_return",
  "sales_return_contra",
  "settlement",
  "settlement_contra",
  "settlement_discount_expense",
  "settlement_discount_income",
  "fx_gain",
  "fx_loss",
] as const;

export type CashImpact = "in" | "out" | "none";

export interface DomainEvent {
  type: string;
  tenantId: UUID;
  occurredAt: Timestamp;
  payload: Record<string, unknown>;
}
