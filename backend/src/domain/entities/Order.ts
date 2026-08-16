import type { UUID, OrderStatus, EntityStatus } from "../types/index.js";

export interface OrderItemData {
  id: UUID;
  fabricId?: UUID;
  fabricName: string;
  colorId?: UUID;
  colorName: string;
  colorCode?: string;
  requestedKg: number;
  /** Optional pinned roll for this item (multi-roll reservation). */
  rollId?: UUID;
  widthCm?: number;
  weightGsm?: number;
  notes?: string;
}

export interface OrderData {
  id: UUID;
  tenantId: UUID;
  code: string;
  customerId?: UUID;
  customerNameSnapshot: string;
  customerPhoneSnapshot?: string;
  date: string;
  status: OrderStatus;
  currency: string;
  notes?: string;
  fulfilledInvoiceId?: UUID;
  items: OrderItemData[];
  version: number;
  createdAt: string;
  updatedAt: string;
}

export class Order {
  private constructor(private readonly data: OrderData) {}

  static create(input: CreateOrderInput): Order {
    return new Order({
      id: "" as UUID,
      tenantId: "" as UUID,
      code: input.code?.trim() ?? "",
      customerId: input.customerId,
      customerNameSnapshot: input.customerNameSnapshot?.trim() ?? "",
      customerPhoneSnapshot: input.customerPhoneSnapshot?.trim(),
      date: input.date,
      status: "open" as OrderStatus,
      currency: input.currency ?? "SYP",
      notes: input.notes?.trim(),
      fulfilledInvoiceId: undefined,
      items: input.items.map((it) => ({
        id: "" as UUID,
        fabricId: it.fabricId,
        fabricName: it.fabricName?.trim() ?? "",
        colorId: it.colorId,
        colorName: it.colorName?.trim() ?? "",
        colorCode: it.colorCode?.trim(),
        requestedKg: it.requestedKg,
        rollId: it.rollId,
        widthCm: it.widthCm,
        weightGsm: it.weightGsm,
        notes: it.notes?.trim(),
      })),
      version: 1,
      createdAt: "",
      updatedAt: "",
    });
  }

  static reconstitute(data: OrderData): Order {
    return new Order(data);
  }

  fulfill(invoiceId: UUID): void {
    if (this.data.status === "cancelled") throw new Error("Cannot fulfill a cancelled order");
    if (this.data.status === "fulfilled") throw new Error("Order already fulfilled");
    this.data.status = "fulfilled";
    this.data.fulfilledInvoiceId = invoiceId;
    this.data.version++;
    this.data.updatedAt = new Date().toISOString();
  }

  cancel(): void {
    if (this.data.status === "cancelled") throw new Error("Order already cancelled");
    if (this.data.status === "fulfilled") throw new Error("Cannot cancel a fulfilled order");
    this.data.status = "cancelled";
    this.data.version++;
    this.data.updatedAt = new Date().toISOString();
  }

  update(
    updates: Partial<
      Pick<OrderData, "notes" | "customerNameSnapshot" | "customerPhoneSnapshot" | "date">
    >,
  ): void {
    if (this.data.status !== "open") throw new Error("Can only update open orders");
    const d = this.data;
    if (updates.notes !== undefined) d.notes = updates.notes?.trim();
    if (updates.customerNameSnapshot !== undefined)
      d.customerNameSnapshot = updates.customerNameSnapshot?.trim() ?? "";
    if (updates.customerPhoneSnapshot !== undefined)
      d.customerPhoneSnapshot = updates.customerPhoneSnapshot?.trim();
    if (updates.date !== undefined) d.date = updates.date;
    d.version++;
    d.updatedAt = new Date().toISOString();
  }

  toData(): OrderData {
    return { ...this.data };
  }

  get id(): UUID {
    return this.data.id;
  }
  get code(): string {
    return this.data.code;
  }
  get status(): OrderStatus {
    return this.data.status;
  }
  get version(): number {
    return this.data.version;
  }
  get customerId(): UUID | undefined {
    return this.data.customerId;
  }
}

export interface CreateOrderItemInput {
  fabricId?: UUID;
  fabricName: string;
  colorId?: UUID;
  colorName: string;
  colorCode?: string;
  requestedKg: number;
  pieces?: number;
  rollId?: UUID;
  widthCm?: number;
  weightGsm?: number;
  notes?: string;
}

export interface CreateOrderInput {
  code?: string;
  customerId?: UUID;
  customerNameSnapshot: string;
  customerPhoneSnapshot?: string;
  date: string;
  currency?: string;
  notes?: string;
  items: CreateOrderItemInput[];
}
