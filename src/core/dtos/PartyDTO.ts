import type { Currency } from "@/domain/types";
import type { PartyKind, PaymentMethod, PartyStatus } from "@/domain/entities/Party";

export type PartyDTO = {
  id: string;
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
  address?: string | null;
  city?: string | null;
  country?: string | null;
  taxNumber?: string | null;
  openingBalance: number;
  creditLimit?: number;
  currency?: Currency;
  paymentTerms?: string;
  paymentMethod?: PaymentMethod;
  defaultDiscount?: number;
  vat?: number;
  notes?: string | null;
  status: PartyStatus;
  createdAt: string;
};

export type CreatePartyInput = {
  kind: PartyKind;
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
  address?: string;
  city?: string;
  country?: string;
  taxNumber?: string;
  openingBalance?: number;
  creditLimit?: number;
  currency?: Currency;
  paymentTerms?: string;
  paymentMethod?: PaymentMethod;
  defaultDiscount?: number;
  vat?: number;
  notes?: string;
};

export type UpdatePartyInput = Partial<Omit<CreatePartyInput, "kind">>;

export type PartyFilter = {
  kind?: PartyKind;
  search?: string;
  status?: PartyStatus;
  page?: number;
  limit?: number;
  offset?: number;
};
