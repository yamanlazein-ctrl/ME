/**
 * Core domain types shared across all bounded contexts.
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
  meta: {
    total: number;
    page: number;
    limit: number;
    hasNext: boolean;
    totalPages: number;
  };
}

export interface PaginationParams {
  page?: number;
  offset?: number;
  limit?: number;
}

export type Currency = "SYP" | "USD" | "EUR";

export type EntityStatus = "active" | "cancelled" | "draft";

export type InvoiceType = "entry" | "sale";

export type VoucherKind = "receipt" | "payment";
export type VoucherMethod = "cash" | "transfer" | "check" | "card";

export type LedgerType =
  | "opening"
  | "purchase_invoice"
  | "sales_invoice"
  | "payment_out"
  | "receipt_in"
  | "purchase_return"
  | "sales_return"
  | "expense"
  | "printing_charge"
  | "adjustment"
  | "settlement"
  | "cancellation";

export type CashImpact = "in" | "out" | "none";

export type OrderStatus = "open" | "partially_available" | "available" | "fulfilled" | "cancelled";

export type RollStatus = "in_stock" | "exhausted" | "reserved";

export type PartyKind = "customer" | "supplier";

export type ReturnKind = "entry" | "sale";

export type ExpenseCategory = string;

export type ReturnReason = "defect" | "wrong_quantity" | "wrong_order" | "other";

export type PrintJobStatus = "sent" | "received";

export type ManualMovementType =
  "capital" | "withdrawal" | "transfer" | "adjustment" | "correction";
export type MovementDirection = "in" | "out";

export type NotificationKind = "credit" | "aging" | "stock" | "unpaid" | "cash" | "order";
export type NotificationSeverity = "info" | "warning" | "critical";

export type Role = "admin" | "accountant" | "warehouse" | "viewer";

/** Utility to strip readonly from all fields of a type. */
export type Mutable<T> = { -readonly [K in keyof T]: T[K] };

export interface DomainEvent {
  type: string;
  tenantId: UUID;
  occurredAt: Timestamp;
  payload: Record<string, unknown>;
}
