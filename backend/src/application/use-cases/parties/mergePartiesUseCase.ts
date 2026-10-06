/**
 * OLD-PLAN Phase 3.4 — merge duplicate parties into one survivor.
 * Moves invoices, vouchers, returns, ledger party_id; soft-cancels the source.
 */
import type { IPartyRepository } from "../../ports/IPartyRepository.js";
import type { TenantContext } from "../../../domain/types/index.js";
import { BusinessRuleError } from "../../../domain/errors/index.js";

export type MergePartiesResult = {
  survivorId: string;
  sourceId: string;
  moved: { invoices: number; vouchers: number; returns: number; ledger: number };
};

export async function mergePartiesUseCase(
  partyRepo: IPartyRepository,
  survivorId: string,
  sourceId: string,
  ctx: TenantContext,
): Promise<MergePartiesResult> {
  if (survivorId === sourceId) {
    throw new BusinessRuleError("لا يمكن دمج الطرف مع نفسه");
  }
  return partyRepo.mergeInto(survivorId, sourceId, ctx);
}