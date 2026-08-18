import type { UUID, EntityStatus, InvoiceType } from "../types/index.js";

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
  date: string;
  partyId: UUID;
  partyType: "customer" | "supplier";
  currency: string;
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
    const total = subtotal - discount + tax + shipping;
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
  return lines.reduce(
    (s, l) => s + Math.max(0, Math.round(l.quantityKg * l.pricePerKg - (l.discountAmount ?? 0))),
    0,
  );
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
   * Optional order being fulfilled by this invoice (sale invoices only). When
   * present, reserved rolls pinned to that order are allowed to be sold; a
   * reserved roll NOT owned by this order is rejected (BUG-17).
   */
  orderId?: UUID;
}
