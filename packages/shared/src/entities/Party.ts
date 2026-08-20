export type PartyKind = "customer" | "supplier";
export type PartyStatus = "active" | "inactive" | "cancelled";

export interface PartyData {
  id: string;
  tenantId: string;
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
  openingBalance: number;
  creditLimit: number;
  currency: string;
  paymentTerms?: string;
  paymentMethod?: string;
  defaultDiscount: number;
  vat: number;
  status: PartyStatus;
  notes?: string | null;
  version: number;
  createdAt: string;
  createdBy?: string | null;
  updatedAt?: string;
  cancelledAt?: string | null;
  cancelledBy?: string | null;
}

export function createPartyData(input: {
  kind: PartyKind;
  name: string;
  tenantId: string;
  createdBy?: string | null;
  code?: string;
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
}): PartyData {
  if (!input.name?.trim()) throw new Error("Party name is required.");
  return {
    id: crypto.randomUUID(),
    tenantId: input.tenantId,
    kind: input.kind,
    code: input.code?.trim(),
    name: input.name.trim(),
    companyName: input.companyName?.trim() ?? null,
    commercialReg: input.commercialReg?.trim() ?? null,
    category: input.category?.trim() ?? null,
    salesRep: input.salesRep?.trim() ?? null,
    phone: input.phone?.trim() ?? null,
    mobile: input.mobile?.trim() ?? null,
    whatsapp: input.whatsapp?.trim() ?? null,
    altPhone: input.altPhone?.trim() ?? null,
    email: input.email?.trim() ?? null,
    website: input.website?.trim() ?? null,
    address: input.address?.trim() ?? null,
    city: input.city?.trim() ?? null,
    country: input.country?.trim() ?? null,
    taxNumber: input.taxNumber?.trim() ?? null,
    openingBalance: input.openingBalance ?? 0,
    creditLimit: input.creditLimit ?? 0,
    currency: input.currency ?? "SYP",
    paymentTerms: input.paymentTerms,
    paymentMethod: input.paymentMethod,
    defaultDiscount: input.defaultDiscount ?? 0,
    vat: input.vat ?? 0,
    status: "active",
    notes: input.notes?.trim() ?? null,
    version: 1,
    createdAt: new Date().toISOString(),
    createdBy: input.createdBy ?? null,
    updatedAt: new Date().toISOString(),
    cancelledAt: null,
    cancelledBy: null,
  };
}

export function canCancelParty(status: PartyStatus): boolean {
  return status === "active";
}
