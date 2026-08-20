import { TenantContext, UUID, MoneyData } from "@/domain/types";
import { ILedgerRepository } from "@/application/ports/ILedgerRepository";

export class GetPartyBalanceUseCase {
  constructor(private readonly ledger: ILedgerRepository) {}

  async execute(partyId: UUID, currency: string, ctx: TenantContext): Promise<MoneyData> {
    return this.ledger.balance(partyId, currency, ctx);
  }
}
