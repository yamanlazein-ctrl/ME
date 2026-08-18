import type { TenantContext, UUID } from "../../domain/types/index.js";
import type {
  PartyStatementData,
  StatementQuery,
} from "../../domain/entities/Statement.js";
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
 * The statement is computed server-side so the UI gets:
 *  - previous balance (sum of movements strictly before `from`, signed by kind)
 *  - chronological entries with running balance + expandable invoice line details
 *  - totals + final balance
 * No pagination / hidden limits: the acceptance criteria require the full,
 * unfiltered register for each party.
 */
export interface IStatementRepository {
  getStatement(query: StatementQuery, ctx: TenantContext): Promise<PartyStatementData>;
  /**
   * Zero the party's current balance by writing a `settlement` ledger entry on
   * the opposite side. Throws if the balance is already zero (nothing to settle).
   */
  settle(
    partyId: UUID,
    input: SettlePartyInput,
    ctx: TenantContext,
  ): Promise<LedgerEntryData>;
}