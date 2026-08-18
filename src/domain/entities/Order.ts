import { Timestamp, UUID, Currency, Mutable } from "@/domain/types";

export type OrderStatus = "open" | "partially_available" | "available" | "fulfilled" | "cancelled";

export interface OrderItemData {
  id: UUID;
  fabricId?: UUID | null;
  fabricName: string;
  colorId?: UUID | null;
  colorName: string;
  colorCode?: string | null;
  requestedKg: number;
  widthCm?: number | null;
  weightGsm?: number | null;
  notes?: string | null;
}

export interface OrderData {
  id: UUID;
  tenantId: UUID;
  code: string;
  customerId?: UUID | null;
  customerNameSnapshot: string;
  customerPhoneSnapshot?: string | null;
  date: string;
  status: OrderStatus;
  notes?: string | null;
  currency: Currency;
  items: readonly OrderItemData[];
  fulfilledInvoiceId?: UUID | null;
  createdAt: Timestamp;
  createdBy: string;
  cancelledAt?: Timestamp | null;
  cancelledBy?: string | null;
}

export class Order implements OrderData {
  readonly id: UUID;
  readonly tenantId: UUID;
  readonly code: string;
  readonly customerId: UUID | null;
  readonly customerNameSnapshot: string;
  readonly customerPhoneSnapshot: string | null;
  readonly date: string;
  status: OrderStatus;
  readonly notes: string | null;
  readonly currency: Currency;
  readonly items: readonly OrderItemData[];
  fulfilledInvoiceId: UUID | null;
  readonly createdAt: Timestamp;
  readonly createdBy: string;
  cancelledAt: Timestamp | null;
  cancelledBy: string | null;

  private constructor(data: OrderData) {
    this.id = data.id;
    this.tenantId = data.tenantId;
    this.code = data.code;
    this.customerId = data.customerId ?? null;
    this.customerNameSnapshot = data.customerNameSnapshot;
    this.customerPhoneSnapshot = data.customerPhoneSnapshot ?? null;
    this.date = data.date;
    this.status = data.status;
    this.notes = data.notes ?? null;
    this.currency = data.currency;
    this.items = Object.freeze(data.items);
    this.fulfilledInvoiceId = data.fulfilledInvoiceId ?? null;
    this.createdAt = data.createdAt;
    this.createdBy = data.createdBy;
    this.cancelledAt = data.cancelledAt ?? null;
    this.cancelledBy = data.cancelledBy ?? null;
  }

  /** Reconstitute from persistence (skip validation). */
  static reconstitute(data: OrderData): Order {
    return new Order(data);
  }

  static create(props: {
    tenantId: UUID;
    customerId?: UUID | null;
    customerNameSnapshot: string;
    customerPhoneSnapshot?: string | null;
    date: string;
    notes?: string | null;
    currency: Currency;
    items: Omit<OrderItemData, "id">[];
    id?: UUID;
    code?: string;
    status?: OrderStatus;
    createdBy?: string;
  }): Order {
    if (!props.customerNameSnapshot?.trim()) {
      throw new Error("Customer name is required.");
    }
    if (!props.items?.length) {
      throw new Error("At least one item is required.");
    }

    const now = new Date().toISOString() as Timestamp;
    const items: OrderItemData[] = props.items.map((item) => ({
      ...item,
      id: crypto.randomUUID() as UUID,
      fabricId: item.fabricId ?? null,
      colorId: item.colorId ?? null,
      colorCode: item.colorCode ?? null,
      widthCm: item.widthCm ?? null,
      weightGsm: item.weightGsm ?? null,
      notes: item.notes ?? null,
    }));

    return new Order({
      ...props,
      id: props.id ?? (crypto.randomUUID() as UUID),
      code: props.code ?? "",
      status: props.status ?? "open",
      items: Object.freeze(items),
      fulfilledInvoiceId: null,
      createdAt: now,
      createdBy: props.createdBy ?? "system",
      cancelledAt: null,
      cancelledBy: null,
    } as OrderData);
  }

  totalItems(): number {
    return this.items.reduce((sum, item) => sum + item.requestedKg, 0);
  }

  canFulfill(): boolean {
    return (
      this.status === "open" || this.status === "partially_available" || this.status === "available"
    );
  }

  canCancel(): boolean {
    return this.status !== "cancelled" && this.status !== "fulfilled";
  }

  cancel(userName: string): void {
    if (!this.canCancel()) return;
    (this as Mutable<this>).status = "cancelled";
    (this as Mutable<this>).cancelledAt = new Date().toISOString() as Timestamp;
    (this as Mutable<this>).cancelledBy = userName;
  }

  fulfill(invoiceId: UUID): void {
    if (this.status === "cancelled" || this.status === "fulfilled") return;
    (this as Mutable<this>).status = "fulfilled";
    (this as Mutable<this>).fulfilledInvoiceId = invoiceId;
  }

  toJSON(): OrderData {
    return { ...this };
  }
}
