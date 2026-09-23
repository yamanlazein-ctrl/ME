import type { TenantContext, UUID } from "../../domain/types/index.js";
import type { PartyStatementData, StatementQuery } from "../../domain/entities/Statement.js";
import type { LedgerEntryData } from "../../domain/entities/LedgerEntry.js";

export interface SettlePartyInput {
  date?: string;
  currency?: string;
  notesInternal?: string;
  referenceNumber: string;
}

/**
 * Party statement (كشف حساب) + settlement (تسوية).
 *
 * Totals always cover the full filter window. Entry pages are bounded
 * (default/max limit enforced in PostgresStatementRepository).
 */
export interface IStatementRepository {
  getStatement(query: StatementQuery, ctx: TenantContext): Promise<PartyStatementData>;
  /**
   * Zero the party's current balance by writing a `settlement` ledger entry on
   * the opposite side. Throws if the balance is already zero (nothing to settle).
   */
  settle(partyId: UUID, input: SettlePartyInput, ctx: TenantContext): Promise<LedgerEntryData>;
}
