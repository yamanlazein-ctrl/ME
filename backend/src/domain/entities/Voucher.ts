import type { UUID, EntityStatus, VoucherKind, VoucherMethod } from "../types/index.js";

export interface VoucherData {
  id: UUID;
  tenantId: UUID;
  kind: VoucherKind;
  number: string;
  date: string;
  partyId: UUID;
  partyKind: "customer" | "supplier";
  invoiceId?: UUID;
  amount: number;
  currency: string;
  /** Units of `currency` per 1 USD — frozen at creation. */
  exchangeRate?: number | null;
  /** USD equivalent of `amount` at the frozen rate. */
  baseAmount?: number | null;
  /**
   * Currency + frozen rate of the LINKED INVOICE, carried along so the print
   * template can show the voucher's counterpart in the invoice's currency
   * ("المقابل: 13,200 ل.س بسعر صرف 132") without a second round-trip.
   * Undefined for standalone payments.
   */
  invoiceCurrency?: string;
  invoiceExchangeRate?: number | null;
  method: VoucherMethod;
  status: EntityStatus;
  notesPrint?: string;
  notesInternal?: string;
  attachments: unknown[];
  version: number;
  createdAt: string;
  createdBy?: UUID;
  updatedAt: string;
  cancelledAt?: string;
  cancelledBy?: UUID;
}

export class Voucher {
  private constructor(private readonly data: VoucherData) {}

  static create(input: CreateVoucherInput, number: string): Voucher {
    return new Voucher({
      id: "" as UUID,
      tenantId: "" as UUID,
      kind: input.kind,
      number,
      date: input.date,
      partyId: input.partyId,
      partyKind: input.partyKind,
      invoiceId: input.invoiceId,
      amount: input.amount,
      currency: input.currency ?? "SYP",
      method: input.method,
      status: "active" as EntityStatus,
      notesPrint: input.notesPrint?.trim(),
      notesInternal: input.notesInternal?.trim(),
      attachments: [],
      version: 1,
      createdAt: "",
      createdBy: undefined,
      updatedAt: "",
      cancelledAt: undefined,
      cancelledBy: undefined,
    });
  }

  static reconstitute(data: VoucherData): Voucher {
    return new Voucher(data);
  }

  cancel(cancelledBy: UUID): void {
    if (this.data.status === "cancelled") throw new Error("Voucher already cancelled");
    this.data.status = "cancelled";
    this.data.cancelledAt = new Date().toISOString();
    this.data.cancelledBy = cancelledBy;
    this.data.version++;
    this.data.updatedAt = new Date().toISOString();
  }

  toData(): VoucherData {
    return { ...this.data };
  }

  get id(): UUID {
    return this.data.id;
  }
  get kind(): VoucherKind {
    return this.data.kind;
  }
  get amount(): number {
    return this.data.amount;
  }
  get partyId(): UUID {
    return this.data.partyId;
  }
  get invoiceId(): UUID | undefined {
    return this.data.invoiceId;
  }
  get status(): EntityStatus {
    return this.data.status;
  }
  get version(): number {
    return this.data.version;
  }
  get isCancelled(): boolean {
    return this.data.status === "cancelled";
  }
}

export interface CreateVoucherInput {
  kind: VoucherKind;
  date: string;
  partyId: UUID;
  partyKind: "customer" | "supplier";
  invoiceId?: UUID;
  amount: number;
  currency?: string;
  /** Units of `currency` per 1 USD — frozen at creation. */
  exchangeRate?: number;
  method: VoucherMethod;
  notesPrint?: string;
  notesInternal?: string;
  /** Sync replay: keep originating device number. */
  preAllocatedNumber?: string;
  /** Sync replay: keep originating device id. */
  preAllocatedId?: UUID;
}
