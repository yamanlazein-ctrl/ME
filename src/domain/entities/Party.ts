import { Timestamp, UUID, Currency, Mutable, VoucherMethod } from "@/domain/types";

export type PaymentTerms = "cash" | "net15" | "net30" | "net60" | "net90";
export type PaymentMethod = VoucherMethod;
export type PartyStatus = "active" | "inactive" | "cancelled";
export type PartyKind = "customer" | "supplier";

export type PartyAttachment = {
  id: UUID;
  name: string;
  size: number;
  uploadedAt: Timestamp;
};

export type PartyActivityKind =
  "created" | "updated" | "invoice" | "payment" | "note" | "adjustment";

export type ActivityEntry = {
  id: UUID;
  at: Timestamp;
  kind: PartyActivityKind;
  message: string;
};

export interface PartyData {
  id: UUID;
  tenantId: UUID;
  kind: PartyKind;
  code?: string;
  name: string;
  companyName?: string | null;
  commercialReg?: string | null;
  category?: string | null;
  salesRep?: string | null;
  phone?: string | null;
  mobile?: string | null;
  whatsapp?: string | null;
  altPhone?: string | null;
  email?: string | null;
  website?: string | null;
  address?: string | null;
  city?: string | null;
  country?: string | null;
  taxNumber?: string | null;
  openingBalance?: number;
  creditLimit?: number;
  currency?: Currency;
  paymentTerms?: PaymentTerms;
  paymentMethod?: PaymentMethod;
  defaultDiscount?: number;
  vat?: number;
  notes?: string | null;
  status: PartyStatus;
  attachments: PartyAttachment[];
  activity: ActivityEntry[];
  createdAt: Timestamp;
  createdBy?: string | null;
  cancelledAt?: Timestamp | null;
  cancelledBy?: string | null;
}

export class Party implements PartyData {
  readonly id: UUID;
  readonly tenantId: UUID;
  readonly kind: PartyKind;
  readonly code?: string;
  readonly name: string;
  readonly companyName: string | null;
  readonly commercialReg: string | null;
  readonly category: string | null;
  readonly salesRep: string | null;
  readonly phone: string | null;
  readonly mobile: string | null;
  readonly whatsapp: string | null;
  readonly altPhone: string | null;
  readonly email: string | null;
  readonly website: string | null;
  readonly address: string | null;
  readonly city: string | null;
  readonly country: string | null;
  readonly taxNumber: string | null;
  readonly openingBalance: number;
  readonly creditLimit?: number;
  readonly currency?: Currency;
  readonly paymentTerms?: PaymentTerms;
  readonly paymentMethod?: PaymentMethod;
  readonly defaultDiscount?: number;
  readonly vat?: number;
  readonly notes: string | null;
  status: PartyStatus;
  readonly attachments: PartyAttachment[];
  readonly activity: ActivityEntry[];
  readonly createdAt: Timestamp;
  readonly createdBy: string | null;
  readonly cancelledAt?: Timestamp | null;
  readonly cancelledBy?: string | null;

  private constructor(data: PartyData) {
    this.id = data.id;
    this.tenantId = data.tenantId;
    this.kind = data.kind;
    this.code = data.code;
    this.name = data.name;
    this.companyName = data.companyName ?? null;
    this.commercialReg = data.commercialReg ?? null;
    this.category = data.category ?? null;
    this.salesRep = data.salesRep ?? null;
    this.phone = data.phone ?? null;
    this.mobile = data.mobile ?? null;
    this.whatsapp = data.whatsapp ?? null;
    this.altPhone = data.altPhone ?? null;
    this.email = data.email ?? null;
    this.website = data.website ?? null;
    this.address = data.address ?? null;
    this.city = data.city ?? null;
    this.country = data.country ?? null;
    this.taxNumber = data.taxNumber ?? null;
    this.openingBalance = data.openingBalance ?? 0;
    this.creditLimit = data.creditLimit;
    this.currency = data.currency;
    this.paymentTerms = data.paymentTerms;
    this.paymentMethod = data.paymentMethod;
    this.defaultDiscount = data.defaultDiscount;
    this.vat = data.vat;
    this.notes = data.notes ?? null;
    this.status = data.status;
    this.attachments = data.attachments;
    this.activity = data.activity;
    this.createdAt = data.createdAt;
    this.createdBy = data.createdBy ?? null;
    this.cancelledAt = data.cancelledAt ?? null;
    this.cancelledBy = data.cancelledBy ?? null;
  }

  /** Reconstitute from persistence (skip validation). */
  static reconstitute(data: PartyData): Party {
    return new Party(data);
  }

  static create(
    props: Omit<PartyData, "id" | "status" | "createdAt" | "attachments" | "activity"> & {
      id?: UUID;
    },
  ): Party {
    if (!props.name?.trim()) {
      throw new Error("Party name is required.");
    }

    return new Party({
      ...props,
      id: props.id ?? crypto.randomUUID(),
      status: "active",
      attachments: [],
      activity: [],
      createdAt: new Date().toISOString(),
      tenantId: props.tenantId,
      kind: props.kind,
      createdBy: props.createdBy ?? null,
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
    (this as Mutable<this>).cancelledBy = userName;
    (this as Mutable<this>).cancelledAt = new Date().toISOString();
    this.activity.push({
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      kind: "updated",
      message: `Party cancelled: ${this.kind === "customer" ? "customer" : "supplier"} ${this.name}`,
    });
  }

  toJSON(): PartyData {
    return { ...this };
  }
}
