import { LedgerEntry, LedgerEntryData } from "@/domain/entities/LedgerEntry";
import { Money } from "@/domain/value-objects/Money";
import { Result } from "@/core/result";
import { TenantContext, UUID } from "@/domain/types";
import { PaginatedResult, PaginationParams } from "@/domain/types";

/**
 * Port: LedgerRepository — append-only ledger with immutable entries.
 */
export interface ILedgerRepository {
  /**
   * Query ledger entries. Includes both active and cancelled by default
   * unless filter.status is set.
   */
  entries(filter: LedgerFilter, ctx: TenantContext): Promise<PaginatedResult<LedgerEntry>>;

  /**
   * Append a new ledger entry.
   */
  write(entry: LedgerEntry, ctx: TenantContext): Promise<LedgerEntry>;

  /**
   * Soft-cancel all ledger entries tied to a reference.
   */
  cancelByReference(referenceId: UUID, ctx: TenantContext): Promise<void>;

  /**
   * Running balance for a party. Computed from active entries only.
   */
  balance(partyId: UUID, currency: string, ctx: TenantContext): Promise<Money>;

  /**
   * Total cash movements on a specific date.
   */
  cashMovementsOn(
    date: string,
    currency: string,
    ctx: TenantContext,
  ): Promise<{ in: number; out: number }>;
}

export interface LedgerFilter extends PaginationParams {
  partyId?: UUID;
  referenceId?: UUID;
  types?: LedgerEntry["type"][];
  fromDate?: string;
  toDate?: string;
  status?: "active" | "cancelled" | "all";
}
