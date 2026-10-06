import type { TenantContext, PaginatedResult, PartyKind } from "../../domain/types/index.js";
import type { PartyData } from "../../domain/entities/Party.js";

export interface PartyFilter {
  /** Keyset cursor ("load every row" callers) — see keysetPage.ts. */
  cursor?: string;
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
  /** Signed SoT (customer + = they owe us; supplier + = we owe them). */
  openingBalance?: number;
  /** Absolute amount from UI; wins when paired with openingDirection. */
  openingAmount?: number;
  openingDirection?: "they_owe_us" | "we_owe_them";
  openingDate?: string;
  openingNote?: string;
  /** Opening journal currency (SYP/USD); defaults to the party's currency. */
  openingCurrency?: string;
  creditLimit?: number;
  currency?: string;
  paymentTerms?: string;
  paymentMethod?: string;
  defaultDiscount?: number;
  vat?: number;
  notes?: string;
  status?: string;
}

/** A replacement opening balance: `amount` is already SIGNED (see signedOpeningBalance). */
export interface PartyOpeningData {
  openingBalance: number;
  currency: string;
  date: string;
  note?: string | null;
}

export interface IPartyRepository {
  /** Merge sourceId into survivorId (moves documents + ledger, soft-cancels the source). S1. */
  mergeInto(
    survivorId: string,
    sourceId: string,
    ctx: TenantContext,
  ): Promise<{ survivorId: string; sourceId: string; moved: { invoices: number; vouchers: number; returns: number; ledger: number } }>;
  findById(id: string, ctx: TenantContext): Promise<PartyData | null>;
  findByCode(code: string, ctx: TenantContext): Promise<PartyData | null>;
  list(filter: PartyFilter, ctx: TenantContext): Promise<PaginatedResult<PartyData>>;
  create(data: CreatePartyData, ctx: TenantContext): Promise<PartyData>;
  update(id: string, data: Partial<CreatePartyData>, ctx: TenantContext, expectedVersion: number): Promise<PartyData>;
  /**
   * Replace the opening balance in one transaction: the active opening journal is cancelled
   * (kept for audit, never deleted), a new balanced one is posted when the amount ≠ 0, the
   * parties.opening_* columns are rewritten and the version bumped. Refused in a closed year.
   */
  setOpening(id: string, data: PartyOpeningData, ctx: TenantContext, expectedVersion: number): Promise<PartyData>;
  cancel(id: string, cancelledBy: string, ctx: TenantContext, expectedVersion: number): Promise<PartyData>;
  /**
   * Sync: after applying a hub-canonical update, mirror the HUB's version number. The hub accepts an
   * update only when its base version equals the hub row's version, so a device whose counter ran ahead
   * (it also counted its own losing edit) could never sync another edit of this party. Version only.
   */
  alignVersion(id: string, version: number, ctx: TenantContext): Promise<void>;
}
