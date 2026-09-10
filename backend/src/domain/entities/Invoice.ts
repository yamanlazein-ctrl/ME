import type { UUID, EntityStatus, InvoiceType } from "../types/index.js";
import { computeSubtotal as sharedSubtotal, round2dp } from "@erp/shared";

export interface InvoiceLineData {
  id: UUID;
  fabricId: UUID;
  colorId: UUID;
  rollId: UUID;
  quantityKg: number;
  pieces: number;
  pricePerKg: number;
  discountAmount: number;
  note?: string;
}

export interface InvoiceData {
  id: UUID;
  tenantId: UUID;
  number: string;
  type: InvoiceType;
  /** Human-readable reference (ENT-2026-0001 / INV-2026-0001). */
  reference?: string | null;
  date: string;
  partyId: UUID;
  partyType: "customer" | "supplier";
  currency: string;
  /** Units of `currency` per 1 USD — frozen at creation (null for legacy rows). */
  exchangeRate?: number | null;
  /** USD equivalent of `total` at the frozen exchangeRate. */
  baseTotal?: number | null;
  subtotal: number;
  discount: number;
  tax: number;
  shipping: number;
  total: number;
  /** Amount paid at invoice time (entry = supplier payment, sale = receipt). */
  paid: number;
  /** Outstanding amount = total - paid. */
  amountDue: number;
  /** Payment method used when paid > 0 (cash/transfer/check/card). */
  paymentMethod?: "cash" | "transfer" | "check" | "card";
  notes?: string;
  status: EntityStatus;
  lines: InvoiceLineData[];
  version: number;
  createdAt: string;
  createdBy?: UUID;
  updatedAt: string;
  cancelledAt?: string;
  cancelledBy?: UUID;
  cancellationReferenceId?: UUID;
}

export class Invoice {
  private constructor(private readonly data: InvoiceData) {}

  static create(input: CreateInvoiceInput, number: string): Invoice {
    const lines = input.lines.map((l) => ({
      id: "" as UUID,
      fabricId: l.fabricId,
      colorId: l.colorId,
      rollId: l.rollId,
      quantityKg: l.quantityKg,
      pieces: l.pieces ?? 1,
      pricePerKg: l.pricePerKg,
      discountAmount: l.discountAmount ?? 0,
      note: l.note?.trim(),
    }));
    const subtotal = computeSubtotal(lines);
    const discount = input.discount ?? 0;
    const tax = input.tax ?? 0;
    const shipping = input.shipping ?? 0;
    // One edge-round keeps cents exact and kills float accumulation.
    const total = round2dp(subtotal - discount + tax + shipping);
    const paid = input.paid ?? 0;
    const paymentMethod = paid > 0 ? (input.paymentMethod ?? "cash") : undefined;
    return new Invoice({
      id: "" as UUID,
      tenantId: "" as UUID,
      number,
      type: input.type,
      date: input.date,
      partyId: input.partyId,
      partyType: input.partyType,
      currency: input.currency ?? "SYP",
      subtotal,
      discount,
      tax,
      shipping,
      total,
      paid,
      amountDue: total - paid,
      paymentMethod,
      notes: input.notes?.trim(),
      status: "active" as EntityStatus,
      lines,
      version: 1,
      createdAt: "",
      createdBy: undefined,
      updatedAt: "",
      cancelledAt: undefined,
      cancelledBy: undefined,
      cancellationReferenceId: undefined,
    });
  }

  static reconstitute(data: InvoiceData): Invoice {
    return new Invoice(data);
  }

  cancel(cancelledBy: UUID): void {
    if (this.data.status === "cancelled") throw new Error("Invoice already cancelled");
    this.data.status = "cancelled";
    this.data.cancelledAt = new Date().toISOString();
    this.data.cancelledBy = cancelledBy;
    this.data.version++;
    this.data.updatedAt = new Date().toISOString();
  }

  toData(): InvoiceData {
    return { ...this.data };
  }

  get id(): UUID {
    return this.data.id;
  }
  get number(): string {
    return this.data.number;
  }
  get type(): InvoiceType {
    return this.data.type;
  }
  get partyId(): UUID {
    return this.data.partyId;
  }
  get status(): EntityStatus {
    return this.data.status;
  }
  get version(): number {
    return this.data.version;
  }
  get total(): number {
    return this.data.total;
  }
  get lines(): InvoiceLineData[] {
    return this.data.lines;
  }
  get isCancelled(): boolean {
    return this.data.status === "cancelled";
  }
}

export function computeSubtotal(lines: InvoiceLineData[]): number {
  return sharedSubtotal(lines as unknown as import("@erp/shared").InvoiceLineData[]);
}

export interface CreateInvoiceLineInput {
  fabricId: UUID;
  colorId: UUID;
  rollId: UUID;
  quantityKg: number;
  pieces?: number;
  pricePerKg: number;
  discountAmount?: number;
  note?: string;
}

export interface CreateInvoiceInput {
  type: InvoiceType;
  date: string;
  partyId: UUID;
  partyType: "customer" | "supplier";
  currency?: string;
  /** Human-readable reference. Server defaults it to the generated number. */
  reference?: string;
  lines: CreateInvoiceLineInput[];
  discount?: number;
  tax?: number;
  shipping?: number;
  notes?: string;
  /**
   * Amount paid at invoice time. For sale invoices it drives a linked receipt
   * voucher (customer payment); for entry invoices it drives a linked
   * payment_out voucher (supplier payment). In both cases the amount is stored
   * on the invoice and `amountDue = total - paid` is exposed.
   */
  paid?: number;
  /** Receipt method used when `paid > 0`. Defaults to "cash". */
  paymentMethod?: "cash" | "transfer" | "check" | "card";
  /**
   * BUG-03 fix: frozen FX rate (units of `currency` per 1 USD) captured at
   * invoice creation. Ignored/forced to 1 for USD (base) invoices. Non-USD
   * invoices without a rate keep NULL base amounts (legacy-data constraint —
   * never guess a current rate for a historical document).
   */
  exchangeRate?: number;
  /**
   * Optional order being fulfilled by this invoice (sale invoices only). When
   * present, reserved rolls pinned to that order are allowed to be sold; a
   * reserved roll NOT owned by this order is rejected (BUG-17).
   */
  orderId?: UUID;
  /**
   * Final document number already reserved from a device block (PRE_ALLOCATED).
   * Used when replaying a synced create on the hub — must not bump sequences.
   */
  preAllocatedNumber?: string;
  /**
   * Stable invoice id from the originating device — hub/peer replay must
   * insert the same UUID so cross-device references stay aligned.
   */
  preAllocatedId?: UUID;
}

/** Editable fields for PUT /invoices/:id. partyId/type/currency/paid are
 *  immutable after creation — cancel & recreate instead. Lines are replaced
 *  wholesale and MUST reference existing rolls. */
export interface UpdateInvoiceInput {
  date: string;
  /** Optional frozen FX rate (units of `currency` per 1 USD), re-captured on
   *  edit. Omitted → the repository falls back to the rate stored on the invoice;
   *  USD documents are always 1. */
  exchangeRate?: number | null;
  lines: CreateInvoiceLineInput[];
  discount?: number;
  tax?: number;
  shipping?: number;
  notes?: string;
}
