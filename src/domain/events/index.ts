import { DomainEvent, UUID, Timestamp } from "@/domain/types";

/* ── Factory helpers ─────────────────────────────────────────────────── */

function makeEvent(type: string, tenantId: UUID, payload: unknown): DomainEvent {
  return {
    type,
    tenantId,
    occurredAt: new Date().toISOString() as Timestamp,
    payload: payload as Record<string, unknown>,
  };
}

/* ── Invoice events ──────────────────────────────────────────────────── */

export interface InvoiceCreatedPayload {
  invoiceId: UUID;
  number: string;
  type: "entry" | "sale" | "return";
  partyId: UUID;
  totalAmount: number;
  currency: string;
}

export interface InvoiceCancelledPayload {
  invoiceId: UUID;
  number: string;
  cancelledBy: string;
}

export const InvoiceCreated = (tenantId: UUID, payload: InvoiceCreatedPayload): DomainEvent =>
  makeEvent("InvoiceCreated", tenantId, payload);

export const InvoiceCancelled = (tenantId: UUID, payload: InvoiceCancelledPayload): DomainEvent =>
  makeEvent("InvoiceCancelled", tenantId, payload);

/* ── Stock events ────────────────────────────────────────────────────── */

export interface StockReservedPayload {
  rollId: UUID;
  invoiceId: UUID;
  quantityKg: number;
  remainingKg: number;
}

export interface StockReleasedPayload {
  rollId: UUID;
  invoiceId: UUID;
  quantityKg: number;
  remainingKg: number;
}

export const StockReserved = (tenantId: UUID, payload: StockReservedPayload): DomainEvent =>
  makeEvent("StockReserved", tenantId, payload);

export const StockReleased = (tenantId: UUID, payload: StockReleasedPayload): DomainEvent =>
  makeEvent("StockReleased", tenantId, payload);

/* ── Payment events ──────────────────────────────────────────────────── */

export interface PaymentPayload {
  voucherId: UUID;
  invoiceId?: UUID | null;
  partyId: UUID;
  amount: number;
  currency: string;
}

export const PaymentReceived = (tenantId: UUID, payload: PaymentPayload): DomainEvent =>
  makeEvent("PaymentReceived", tenantId, payload);

export const PaymentMade = (tenantId: UUID, payload: PaymentPayload): DomainEvent =>
  makeEvent("PaymentMade", tenantId, payload);

/* ── Return events ───────────────────────────────────────────────────── */

export interface ReturnPayload {
  returnId: UUID;
  number: string;
  kind: "entry" | "sale";
  partyId: UUID;
  totalAmount: number;
  currency: string;
}

export const ReturnCreated = (tenantId: UUID, payload: ReturnPayload): DomainEvent =>
  makeEvent("ReturnCreated", tenantId, payload);

export const ReturnCancelled = (
  tenantId: UUID,
  payload: Omit<ReturnPayload, "totalAmount" | "currency"> & { cancelledBy: string },
): DomainEvent => makeEvent("ReturnCancelled", tenantId, payload as Record<string, unknown>);

/* ── Voucher events ─────────────────────────────────────────────────────── */

export interface VoucherCancelledPayload {
  voucherId: UUID;
  number: string;
  cancelledBy: string;
}

export const VoucherCancelled = (tenantId: UUID, payload: VoucherCancelledPayload): DomainEvent =>
  makeEvent("VoucherCancelled", tenantId, payload);

/* ── Order events ─────────────────────────────────────────────────────── */

export interface OrderCreatedPayload {
  orderId: UUID;
  code: string;
  customerId?: UUID | null;
  customerName: string;
  itemCount: number;
  totalKg: number;
  currency: string;
}

export const OrderCreated = (tenantId: UUID, payload: OrderCreatedPayload): DomainEvent =>
  makeEvent("OrderCreated", tenantId, payload);

export interface OrderFulfilledPayload {
  orderId: UUID;
  invoiceId: UUID;
  code: string;
}

export const OrderFulfilled = (tenantId: UUID, payload: OrderFulfilledPayload): DomainEvent =>
  makeEvent("OrderFulfilled", tenantId, payload);

export interface OrderCancelledPayload {
  orderId: UUID;
  code: string;
  cancelledBy: string;
}

export const OrderCancelled = (tenantId: UUID, payload: OrderCancelledPayload): DomainEvent =>
  makeEvent("OrderCancelled", tenantId, payload);

/* ── Registry for dispatch ───────────────────────────────────────────── */

export type KnownEventType =
  | "InvoiceCreated"
  | "InvoiceCancelled"
  | "StockReserved"
  | "StockReleased"
  | "PaymentReceived"
  | "PaymentMade"
  | "ReturnCreated"
  | "ReturnCancelled"
  | "VoucherCancelled"
  | "OrderCreated"
  | "OrderFulfilled"
  | "OrderCancelled";
