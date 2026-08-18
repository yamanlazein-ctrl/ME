import type { TenantContext, PaginatedResult, PartyKind } from "../../domain/types/index.js";
import type { PartyData } from "../../domain/entities/Party.js";

export interface PartyFilter {
  kind?: PartyKind;
  search?: string;
  status?: string;
  page?: number;
  limit?: number;
}

export interface CreatePartyData {
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

export interface IPartyRepository {
  findById(id: string, ctx: TenantContext): Promise<PartyData | null>;
  findByCode(code: string, ctx: TenantContext): Promise<PartyData | null>;
  list(filter: PartyFilter, ctx: TenantContext): Promise<PaginatedResult<PartyData>>;
  create(data: CreatePartyData, ctx: TenantContext): Promise<PartyData>;
  update(id: string, data: Partial<CreatePartyData>, ctx: TenantContext): Promise<PartyData>;
  cancel(id: string, cancelledBy: string, ctx: TenantContext): Promise<PartyData>;
}
