import { Timestamp, UUID, Currency, VoucherMethod, Mutable } from "@/domain/types";

export type { VoucherMethod };
export type VoucherKind = "receipt" | "payment";
export type VoucherStatus = "active" | "cancelled";

export type VoucherAttachment = {
  id: UUID;
  name: string;
  size: number;
  uploadedAt: Timestamp;
};

export interface VoucherData {
  id: UUID;
  tenantId: UUID;
  number: string;
  kind: VoucherKind;
  date: string;
  partyId: UUID;
  partyKind: "customer" | "supplier";
  invoiceId?: UUID | null;
  amount: number;
  currency: Currency;
  method: VoucherMethod;
  notesPrint?: string | null;
  notesInternal?: string | null;
  attachments: VoucherAttachment[];
  status: VoucherStatus;
  createdAt: Timestamp;
  createdBy: string;
  cancelledAt?: Timestamp | null;
  cancelledBy?: string | null;
}

export class Voucher implements VoucherData {
  readonly id: UUID;
  readonly tenantId: UUID;
  readonly number: string;
  readonly kind: VoucherKind;
  readonly date: string;
  readonly partyId: UUID;
  readonly partyKind: "customer" | "supplier";
  readonly invoiceId?: UUID | null;
  readonly amount: number;
  readonly currency: Currency;
  readonly method: VoucherMethod;
  readonly notesPrint: string | null;
  readonly notesInternal: string | null;
  readonly attachments: VoucherAttachment[];
  status: VoucherStatus;
  readonly createdAt: Timestamp;
  readonly createdBy: string;
  readonly cancelledAt?: Timestamp | null;
  readonly cancelledBy?: string | null;

  private constructor(data: VoucherData) {
    this.id = data.id;
    this.tenantId = data.tenantId;
    this.number = data.number;
    this.kind = data.kind;
    this.date = data.date;
    this.partyId = data.partyId;
    this.partyKind = data.partyKind;
    this.invoiceId = data.invoiceId;
    this.amount = data.amount;
    this.currency = data.currency;
    this.method = data.method;
    this.notesPrint = data.notesPrint ?? null;
    this.notesInternal = data.notesInternal ?? null;
    this.attachments = data.attachments;
    this.status = data.status;
    this.createdAt = data.createdAt;
    this.createdBy = data.createdBy;
    this.cancelledAt = data.cancelledAt;
    this.cancelledBy = data.cancelledBy;
  }

  /** Reconstitute from persistence (skip validation). */
  static reconstitute(data: VoucherData): Voucher {
    return new Voucher(data);
  }

  static receipt(
    props: Omit<
      VoucherData,
      | "id"
      | "status"
      | "createdAt"
      | "attachments"
      | "kind"
      | "cancelledAt"
      | "cancelledBy"
      | "number"
      | "createdBy"
    > & { number?: string; id?: UUID; createdBy?: string },
  ): Voucher {
    return new Voucher({
      ...props,
      id: props.id ?? crypto.randomUUID(),
      kind: "receipt",
      number: props.number ?? `RCP-${Date.now()}`,
      status: "active",
      attachments: [],
      createdAt: new Date().toISOString(),
      createdBy: props.createdBy ?? "system",
    });
  }

  static payment(
    props: Omit<
      VoucherData,
      | "id"
      | "status"
      | "createdAt"
      | "attachments"
      | "kind"
      | "cancelledAt"
      | "cancelledBy"
      | "number"
      | "createdBy"
    > & { number?: string; id?: UUID; createdBy?: string },
  ): Voucher {
    return new Voucher({
      ...props,
      id: props.id ?? crypto.randomUUID(),
      kind: "payment",
      number: props.number ?? `PAY-${Date.now()}`,
      status: "active",
      attachments: [],
      createdAt: new Date().toISOString(),
      createdBy: props.createdBy ?? "system",
    });
  }

  isActive(): boolean {
    return this.status === "active";
  }

  canCancel(): boolean {
    return this.status === "active";
  }

  cancel(userName: string): void {
    if (this.status === "cancelled") return;
    (this as Mutable<this>).status = "cancelled";
    (this as Mutable<this>).cancelledAt = new Date().toISOString();
    (this as Mutable<this>).cancelledBy = userName;
  }

  toJSON(): VoucherData {
    return { ...this };
  }
}
