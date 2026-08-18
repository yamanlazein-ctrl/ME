import { TenantContext, UUID } from "@/domain/types";
import { IReturnRepository } from "@/application/ports/IReturnRepository";
import { ILedgerRepository } from "@/application/ports/ILedgerRepository";

export class CancelReturnUseCase {
  constructor(
    private readonly returns: IReturnRepository,
    private readonly ledger: ILedgerRepository,
  ) {}

  async execute(id: UUID, ctx: TenantContext): Promise<void> {
    await this.returns.cancel(id, ctx);
    await this.ledger.cancelByReference(id, ctx);
  }
}
