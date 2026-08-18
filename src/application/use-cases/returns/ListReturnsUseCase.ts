import { TenantContext } from "@/domain/types";
import { IReturnRepository, ReturnFilter } from "@/application/ports/IReturnRepository";

export class ListReturnsUseCase {
  constructor(private readonly returns: IReturnRepository) {}

  execute(filter: ReturnFilter, ctx: TenantContext) {
    return this.returns.list(filter, ctx);
  }
}
