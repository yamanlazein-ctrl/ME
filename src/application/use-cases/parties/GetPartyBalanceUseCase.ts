import { PaginatedResult, TenantContext, UUID } from "@/domain/types";
import { ILedgerRepository } from "@/application/ports/ILedgerRepository";
import { Money } from "@/domain/value-objects/Money";

export class GetPartyBalanceUseCase {
  constructor(private readonly ledger: ILedgerRepository) {}

  async execute(partyId: UUID, currency: string, ctx: TenantContext): Promise<Money> {
    return this.ledger.balance(partyId, currency, ctx);
  }
}
