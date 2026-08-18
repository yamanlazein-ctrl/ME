import type { UUID, PartyKind, EntityStatus } from "../types/index.js";

export interface PartyData {
  id: UUID;
  tenantId: UUID;
  kind: PartyKind;
  code?: string;
  name: string;
  companyName?: string;
  commercialReg?: string;
  category?: string;
  salesRep?: string;
  phone?: string;
  mobile?: string;
  whatsapp?: string;
  altPhone?: string;
  email?: string;
  website?: string;
  address?: string;
  city?: string;
  country?: string;
  taxNumber?: string;
  openingBalance: number;
  creditLimit: number;
  currency: string;
  paymentTerms?: string;
  paymentMethod?: string;
  defaultDiscount: number;
  vat: number;
  status: EntityStatus;
  notes?: string;
  attachments: unknown[];
  version: number;
  createdAt: string;
  createdBy?: UUID;
  updatedAt: string;
  cancelledAt?: string;
  cancelledBy?: UUID;
}

export class Party {
  private constructor(private readonly data: PartyData) {}

  static create(input: CreatePartyInput): Party {
    return new Party({
      id: "" as UUID,
      tenantId: "" as UUID,
      kind: input.kind,
      code: input.code,
      name: input.name.trim(),
      companyName: input.companyName?.trim(),
      commercialReg: input.commercialReg?.trim(),
      category: input.category?.trim(),
      salesRep: input.salesRep?.trim(),
      phone: input.phone?.trim(),
      mobile: input.mobile?.trim(),
      whatsapp: input.whatsapp?.trim(),
      altPhone: input.altPhone?.trim(),
      email: input.email?.trim(),
      website: input.website?.trim(),
      address: input.address?.trim(),
      city: input.city?.trim(),
      country: input.country?.trim(),
      taxNumber: input.taxNumber?.trim(),
      openingBalance: input.openingBalance ?? 0,
      creditLimit: input.creditLimit ?? 0,
      currency: input.currency ?? "SYP",
      paymentTerms: input.paymentTerms,
      paymentMethod: input.paymentMethod,
      defaultDiscount: input.defaultDiscount ?? 0,
      vat: input.vat ?? 0,
      status: "active" as EntityStatus,
      notes: input.notes?.trim(),
      attachments: [],
      version: 1,
      createdAt: "",
      createdBy: undefined,
      updatedAt: "",
      cancelledAt: undefined,
      cancelledBy: undefined,
    });
  }

  static reconstitute(data: PartyData): Party {
    return new Party(data);
  }

  update(updates: Partial<CreatePartyInput>): void {
    if (this.isCancelled) throw new Error("Cannot update cancelled party");
    const d = this.data;
    if (updates.name !== undefined) d.name = updates.name.trim();
    if (updates.code !== undefined) d.code = updates.code?.trim();
    if (updates.companyName !== undefined) d.companyName = updates.companyName?.trim();
    if (updates.commercialReg !== undefined) d.commercialReg = updates.commercialReg?.trim();
    if (updates.category !== undefined) d.category = updates.category?.trim();
    if (updates.salesRep !== undefined) d.salesRep = updates.salesRep?.trim();
    if (updates.phone !== undefined) d.phone = updates.phone?.trim();
    if (updates.mobile !== undefined) d.mobile = updates.mobile?.trim();
    if (updates.whatsapp !== undefined) d.whatsapp = updates.whatsapp?.trim();
    if (updates.altPhone !== undefined) d.altPhone = updates.altPhone?.trim();
    if (updates.email !== undefined) d.email = updates.email?.trim();
    if (updates.website !== undefined) d.website = updates.website?.trim();
    if (updates.address !== undefined) d.address = updates.address?.trim();
    if (updates.city !== undefined) d.city = updates.city?.trim();
    if (updates.country !== undefined) d.country = updates.country?.trim();
    if (updates.taxNumber !== undefined) d.taxNumber = updates.taxNumber?.trim();
    if (updates.openingBalance !== undefined) d.openingBalance = updates.openingBalance;
    if (updates.creditLimit !== undefined) d.creditLimit = updates.creditLimit;
    if (updates.currency !== undefined) d.currency = updates.currency;
    if (updates.paymentTerms !== undefined) d.paymentTerms = updates.paymentTerms;
    if (updates.paymentMethod !== undefined) d.paymentMethod = updates.paymentMethod;
    if (updates.defaultDiscount !== undefined) d.defaultDiscount = updates.defaultDiscount;
    if (updates.vat !== undefined) d.vat = updates.vat;
    if (updates.notes !== undefined) d.notes = updates.notes?.trim();
    d.version++;
    d.updatedAt = new Date().toISOString();
  }

  cancel(cancelledBy: string): void {
    if (this.isCancelled) throw new Error("Party already cancelled");
    this.data.status = "cancelled";
    this.data.cancelledAt = new Date().toISOString();
    this.data.cancelledBy = cancelledBy;
    this.data.version++;
  }

  toData(): PartyData {
    return { ...this.data };
  }

  get id(): UUID {
    return this.data.id;
  }
  get tenantId(): UUID {
    return this.data.tenantId;
  }
  get kind(): PartyKind {
    return this.data.kind;
  }
  get name(): string {
    return this.data.name;
  }
  get code(): string | undefined {
    return this.data.code;
  }
  get status(): EntityStatus {
    return this.data.status;
  }
  get isCancelled(): boolean {
    return this.data.status === "cancelled";
  }
  get version(): number {
    return this.data.version;
  }
}

export interface CreatePartyInput {
  kind: PartyKind;
  code?: string;
  name: string;
  companyName?: string;
  commercialReg?: string;
  category?: string;
  salesRep?: string;
  phone?: string;
  mobile?: string;
  whatsapp?: string;
  altPhone?: string;
  email?: string;
  website?: string;
  address?: string;
  city?: string;
  country?: string;
  taxNumber?: string;
  openingBalance?: number;
  creditLimit?: number;
  currency?: string;
  paymentTerms?: string;
  paymentMethod?: string;
  defaultDiscount?: number;
  vat?: number;
  notes?: string;
}
