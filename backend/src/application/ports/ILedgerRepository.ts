import type { TenantContext, PaginatedResult, UUID } from "../../domain/types/index.js";
import type {
  LedgerEntryData,
  CreateLedgerEntryInput,
  PartyBalance,
} from "../../domain/entities/LedgerEntry.js";

export interface LedgerFilter {
  partyId?: UUID;
  type?: string;
  currency?: string;
  fromDate?: string;
  toDate?: string;
  sort?: "asc" | "desc";
  referenceType?: string;
  referenceId?: UUID;
  search?: string;
  page?: number;
  limit?: number;
}

export interface WriteLedgerEntry {
  partyId?: UUID | null;
  date: string;
  type: string;
  debit?: number;
  credit?: number;
  currency: string;
  cashImpact: string;
  referenceType?: string;
  referenceId?: UUID;
  referenceNumber?: string;
  description?: string;
}

export interface ILedgerRepository {
  findById(id: string, ctx: TenantContext): Promise<LedgerEntryData | null>;
  list(filter: LedgerFilter, ctx: TenantContext): Promise<PaginatedResult<LedgerEntryData>>;
  listByParty(partyId: UUID, ctx: TenantContext): Promise<LedgerEntryData[]>;
  writeMany(entries: WriteLedgerEntry[], ctx: TenantContext): Promise<LedgerEntryData[]>;
  cancelByReference(
    referenceType: string,
    referenceId: UUID,
    cancelledBy: string,
    ctx: TenantContext,
  ): Promise<void>;
  getBalance(partyId: UUID, ctx: TenantContext, currency?: string): Promise<PartyBalance>;
  getBalanceByDate(partyId: UUID, date: string, ctx: TenantContext, currency?: string): Promise<PartyBalance>;
  getCashMovementsOn(
    fromDate: string,
    toDate: string,
    currency: string,
    ctx: TenantContext,
  ): Promise<{ in: number; out: number }>;
  /**
   * Document Timeline — all ledger movements linked to a document
   * (referenceType + referenceId), oldest-first. Includes reversal/cancellation
   * rows so the full lifecycle of the document is auditable.
   */
  getDocumentTimeline(
    referenceType: string,
    referenceId: UUID,
    ctx: TenantContext,
  ): Promise<LedgerEntryData[]>;
  /**
   * Document Graph — for an invoice (the hub of most document graphs), returns
   * the full cluster of related records: the invoice's own ledger timeline,
   * linked receipt/payment vouchers, linked returns, and the fulfilling order.
   */
  getDocumentGraph(
    documentType: "invoice" | "voucher" | "return" | "order",
    documentId: UUID,
    ctx: TenantContext,
  ): Promise<unknown>;
}
