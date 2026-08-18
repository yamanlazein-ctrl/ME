import { Party, type PartyData } from "@/domain/entities/Party";
import { TenantContext, UUID, type PaginatedResult } from "@/domain/types";
import type { IPartyRepository, PartyFilter } from "@/application/ports/IPartyRepository";
import { PartyApiService } from "@/infrastructure/api";
import type { PartyDTO } from "@/core/dtos/PartyDTO";

export class ApiPartyRepository implements IPartyRepository {
  constructor(private api: PartyApiService) {}

  async findById(
    id: UUID,
    kind: "customer" | "supplier",
    ctx: TenantContext,
  ): Promise<Party | null> {
    try {
      const dto = await this.api.findById(kind, id);
      return Party.reconstitute(dto as unknown as PartyData);
    } catch (e) {
      console.warn("[ApiRepo] Party findById failed", e);
      return null;
    }
  }

  async findByCode(
    code: string,
    kind: "customer" | "supplier",
    ctx: TenantContext,
  ): Promise<Party | null> {
    try {
      const dto = await this.api.findByCode(kind, code);
      return Party.reconstitute(dto as unknown as PartyData);
    } catch (e) {
      console.warn("[ApiRepo] Party findByCode failed", e);
      return null;
    }
  }

  async list(filter: PartyFilter, ctx: TenantContext): Promise<PaginatedResult<Party>> {
    const kind = (filter.kind as "customer" | "supplier") || "customer";
    const res = await this.api.list(kind, filter);
    const data = res.data.map((dto) => Party.reconstitute(dto as unknown as PartyData));
    return {
      data,
      total: res.meta?.total ?? data.length,
      hasNext: res.meta?.hasNext ?? false,
    };
  }

  async create(party: Party, ctx: TenantContext): Promise<Party> {
    const json = party.toJSON() as unknown as Record<string, unknown>;
    const wire: Record<string, unknown> = {};
    for (const k in json) {
      const v = json[k];
      if (
        v === undefined ||
        v === null ||
        k === "id" ||
        k === "tenantId" ||
        k === "attachments" ||
        k === "activity" ||
        k === "createdAt"
      ) {
        continue;
      }
      wire[k] = v;
    }
    const dto = (await this.api.create(party.kind, wire as Omit<PartyDTO, "id" | "createdAt">)) as unknown as PartyDTO;
    return Party.reconstitute(dto as unknown as PartyData);
  }

  async update(
    id: UUID,
    kind: "customer" | "supplier",
    patch: Partial<Party>,
    ctx: TenantContext,
  ): Promise<Party> {
    const dto = await this.api.update(
      kind,
      id,
      (patch.toJSON ? patch.toJSON() : patch) as Partial<PartyDTO>,
    );
    return Party.reconstitute(dto as unknown as PartyData);
  }

  async delete(id: UUID, kind: "customer" | "supplier", ctx: TenantContext): Promise<void> {
    await this.api.delete(kind, id);
  }
}
