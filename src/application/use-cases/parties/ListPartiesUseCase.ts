import { PaginatedResult, TenantContext } from "@/domain/types";
import { IPartyRepository, PartyFilter } from "@/application/ports/IPartyRepository";
import { Party } from "@/domain/entities/Party";

export class ListPartiesUseCase {
  constructor(private readonly repo: IPartyRepository) {}

  execute(filter: PartyFilter, ctx: TenantContext): Promise<PaginatedResult<Party>> {
    return this.repo.list(filter, ctx);
  }
}
