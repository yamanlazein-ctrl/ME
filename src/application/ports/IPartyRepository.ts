import { Party } from "@/domain/entities/Party";
import { PartyFilter } from "@/core/dtos/PartyDTO";
import { PaginatedResult, TenantContext, UUID } from "@/domain/types";

export { PartyFilter };

export interface IPartyRepository {
  findById(id: UUID, kind: "customer" | "supplier", ctx: TenantContext): Promise<Party | null>;
  findByCode(
    code: string,
    kind: "customer" | "supplier",
    ctx: TenantContext,
  ): Promise<Party | null>;
  list(filter: PartyFilter, ctx: TenantContext): Promise<PaginatedResult<Party>>;
  create(party: Party, ctx: TenantContext): Promise<Party>;
  update(
    id: UUID,
    kind: "customer" | "supplier",
    patch: Partial<Party>,
    ctx: TenantContext,
  ): Promise<Party>;
  delete(id: UUID, kind: "customer" | "supplier", ctx: TenantContext): Promise<void>;
}
