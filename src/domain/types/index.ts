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

export type InvoiceType = "entry" | "sale" | "return";

export type VoucherKind = "receipt" | "payment";
export type VoucherMethod = "cash" | "transfer" | "check" | "card";

/** Utility to strip readonly from all fields of a type. */
export type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export type LedgerType =
  | "opening"
  | "purchase_invoice"
  | "sales_invoice"
  | "payment_out"
  | "receipt_in"
  | "purchase_return"
  | "sales_return"
  | "expense"
  | "adjustment"
  | "settlement";

export type CashImpact = "in" | "out" | "none";

export interface DomainEvent {
  type: string;
  tenantId: UUID;
  occurredAt: Timestamp;
  payload: Record<string, unknown>;
}
