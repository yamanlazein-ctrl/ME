import { TenantContext, UUID } from "@/domain/types";
import { IReturnRepository } from "@/application/ports/IReturnRepository";

/** ERP-007: the server cancel reverses ledger and stock in one transaction (see CancelVoucherUseCase). */
export class CancelReturnUseCase {
  constructor(private readonly returns: IReturnRepository) {}

  async execute(id: UUID, ctx: TenantContext): Promise<void> {
    const current = await this.returns.findById(id, ctx);
    if (!current) {
      throw new Error("المرتجع غير موجود");
    }
    await this.returns.cancel(id, ctx, current.version);
  }
}
