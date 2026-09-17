import { TenantContext, UUID } from "@/domain/types";
import { IReturnRepository } from "@/application/ports/IReturnRepository";
import { ILedgerRepository } from "@/application/ports/ILedgerRepository";

export class CancelReturnUseCase {
  constructor(
    private readonly returns: IReturnRepository,
    private readonly ledger: ILedgerRepository,
  ) {}

  async execute(id: UUID, ctx: TenantContext): Promise<void> {
    const current = await this.returns.findById(id, ctx);
    if (!current) {
      throw new Error("المرتجع غير موجود");
    }
    await this.returns.cancel(id, ctx, current.version);
    await this.ledger.cancelByReference(id, ctx);
  }
}
