import type { UUID, PartyKind, EntityStatus } from "../types/index.js";
import { createPartyData as sharedCreatePartyData } from "@erp/shared";

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
    const base = sharedCreatePartyData({
      kind: input.kind as unknown as import("@erp/shared").PartyKind,
      name: input.name,
      tenantId: "" as string,
      code: input.code,
      companyName: input.companyName,
      commercialReg: input.commercialReg,
      category: input.category,
      salesRep: input.salesRep,
      phone: input.phone,
      mobile: input.mobile,
      whatsapp: input.whatsapp,
      altPhone: input.altPhone,
      email: input.email,
      website: input.website,
      address: input.address,
      city: input.city,
      country: input.country,
      taxNumber: input.taxNumber,
      openingBalance: input.openingBalance,
      creditLimit: input.creditLimit,
      currency: input.currency,
      paymentTerms: input.paymentTerms,
      paymentMethod: input.paymentMethod,
      defaultDiscount: input.defaultDiscount,
      vat: input.vat,
      notes: input.notes,
    });
    return new Party({
      id: "" as UUID,
      tenantId: "" as UUID,
      kind: input.kind,
      code: base.code,
      name: base.name,
      companyName: base.companyName ?? undefined,
      commercialReg: base.commercialReg ?? undefined,
      category: base.category ?? undefined,
      salesRep: base.salesRep ?? undefined,
      phone: base.phone ?? undefined,
      mobile: base.mobile ?? undefined,
      whatsapp: base.whatsapp ?? undefined,
      altPhone: base.altPhone ?? undefined,
      email: base.email ?? undefined,
      website: base.website ?? undefined,
      address: base.address ?? undefined,
      city: base.city ?? undefined,
      country: base.country ?? undefined,
      taxNumber: base.taxNumber ?? undefined,
      openingBalance: base.openingBalance,
      creditLimit: base.creditLimit,
      currency: base.currency,
      paymentTerms: base.paymentTerms ?? undefined,
      paymentMethod: base.paymentMethod ?? undefined,
      defaultDiscount: base.defaultDiscount,
      vat: base.vat,
      status: "active" as EntityStatus,
      notes: base.notes ?? undefined,
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
