import { Timestamp, UUID, Currency, MoneyData, Mutable } from "@/domain/types";
import {
  lineTotal as sharedLineTotal,
  computeSubtotal as sharedSubtotal,
  invoiceTotal as sharedInvoiceTotal,
  round2dp,
} from "@erp/shared";

/* ────────────────────────────────────────────────────────────────────────
 *  Invoice Entity — root aggregate for sale / entry / return documents.
 *  All mutations are self-contained; no external side effects here.
 * ──────────────────────────────────────────────────────────────────────── */

export interface InvoiceLineData {
  id: UUID;
  fabricId: UUID;
  colorId: UUID;
  rollId: UUID;
  quantityKg: number;
  pieces?: number;
  pricePerKg: number;
  discountAmount: number;
  note?: string;
}

export interface InvoiceData {
  id: UUID;
  tenantId: UUID;
  number: string;
  /** Manual/reference invoice number (e.g. "ENT-2026-TMI7"). Optional. */
  reference?: string | null;
  type: "entry" | "sale" | "return";
  date: string; // yyyy-mm-dd
  partyId: UUID;
  partyType: "customer" | "supplier";
  currency: Currency;
  /** Units of `currency` per 1 USD — frozen at creation (null for legacy rows). */
  exchangeRate?: number | null;
  /** USD equivalent of `total` at the frozen exchangeRate. */
  baseTotal?: number | null;
  status: "draft" | "active" | "cancelled";
  lines: readonly InvoiceLineData[];
  discount?: number;
  tax?: number;
  shipping?: number;
  notes?: string;
  /**
    * Amount paid — maintained by the backend on every voucher create/cancel
    * and persisted on the invoice row. Read from the invoice for all display.
    * Initially set at creation time (sale = receipt, entry = supplier payment).
    */
  paid?: number;
  /** Receipt method used when `paid > 0`. Defaults to "cash". */
  paymentMethod?: "cash" | "transfer" | "check" | "card";
  /** Order being fulfilled by this invoice (sale only) — allows its reserved rolls. */
  orderId?: string;
  createdAt: Timestamp;
  createdBy: UUID;
  version: number;
  cancelledAt?: Timestamp | null;
}

export class Invoice implements InvoiceData {
  readonly id: UUID;
  readonly tenantId: UUID;
  readonly number: string;
  readonly reference?: string | null;
  readonly type: InvoiceData["type"];
  readonly date: string;
  readonly partyId: UUID;
  readonly partyType: InvoiceData["partyType"];
  readonly currency: Currency;
  /** Units of `currency` per 1 USD — frozen at creation (null for legacy rows). */
  readonly exchangeRate?: number | null;
  /** USD equivalent of `total` at the frozen exchangeRate. */
  readonly baseTotal?: number | null;
  status: InvoiceData["status"];
  readonly lines: readonly InvoiceLineData[];
  readonly discount?: number;
  readonly tax?: number;
  readonly shipping?: number;
  notes?: string;
  readonly paid?: number;
  readonly paymentMethod?: "cash" | "transfer" | "check" | "card";
  readonly orderId?: string;
  readonly createdAt: Timestamp;
  readonly createdBy: UUID;
  version: number;
  cancelledAt?: Timestamp | null;

  private constructor(data: InvoiceData) {
    this.id = data.id;
    this.tenantId = data.tenantId;
    this.number = data.number;
    this.reference = data.reference;
    this.type = data.type;
    this.date = data.date;
    this.partyId = data.partyId;
    this.partyType = data.partyType;
    this.currency = data.currency;
    this.exchangeRate = data.exchangeRate;
    this.baseTotal = data.baseTotal;
    this.status = data.status;
    this.lines = Object.freeze(data.lines);
    this.discount = data.discount;
    this.tax = data.tax;
    this.shipping = data.shipping;
    this.notes = data.notes;
    this.paid = data.paid;
    this.paymentMethod = data.paymentMethod;
    this.orderId = data.orderId;
    this.createdAt = data.createdAt;
    this.createdBy = data.createdBy;
    this.version = data.version;
    this.cancelledAt = data.cancelledAt;
  }

  /** Create a new invoice. Domain invariants validated before construction. */
  static create(
    props: Omit<InvoiceData, "id" | "status" | "version" | "cancelledAt"> & {
      id?: UUID;
    },
  ): Invoice {
    if (!props.partyId) throw new Error("partyId is required.");
    if (!props.lines?.length) throw new Error("At least one line is required.");
    if (props.lines.some((l) => l.quantityKg <= 0 || l.pricePerKg < 0)) {
      throw new Error("All lines require positive quantity and non-negative price.");
    }

    return new Invoice({
      ...props,
      id: props.id ?? crypto.randomUUID(),
      status: "active",
      version: 1,
      cancelledAt: null,
    });
  }

  /** Compute total from lines after discounts, plus tax and shipping. */
  total(): number {
    return sharedInvoiceTotal({
      lines: this.lines as unknown as import("@erp/shared").InvoiceLineData[],
      discount: this.discount ?? 0,
      tax: this.tax ?? 0,
      shipping: this.shipping ?? 0,
    });
  }

  /** Compute just the lines subtotal (before header-level adjustments). */
  lineSubtotal(): number {
    return sharedSubtotal(this.lines as unknown as import("@erp/shared").InvoiceLineData[]);
  }

  totalMoney(): MoneyData {
    return { amount: this.total(), currency: this.currency };
  }

  lineTotal(line: InvoiceLineData): number {
    return sharedLineTotal(line as unknown as import("@erp/shared").InvoiceLineData);
  }

  /** True when not already cancelled. */
  canCancel(): boolean {
    return this.status === "active";
  }

  /** Reconstitute from persistence (skip validation — assumes data is valid). */
  static reconstitute(data: InvoiceData): Invoice {
    return new Invoice(data);
  }

  /** Idempotent cancellation. Raises if already cancelled. */
  cancel(): void {
    if (this.status === "cancelled") throw new Error("Invoice is already cancelled.");
    (this as Mutable<this>).status = "cancelled";
    (this as Mutable<this>).cancelledAt = new Date().toISOString();
    (this as Mutable<this>).version += 1;
  }
}
