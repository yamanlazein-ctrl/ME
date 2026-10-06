import { Party, type PartyData } from "@/domain/entities/Party";
import { TenantContext, UUID, type PaginatedResult } from "@/domain/types";
import type { IPartyRepository, PartyFilter } from "@/application/ports/IPartyRepository";
import { PartyApiService } from "@/infrastructure/api";
import type { PartyDTO } from "@/core/dtos/PartyDTO";
import type { PartyOpeningInput } from "@erp/shared";

export class ApiPartyRepository implements IPartyRepository {
  constructor(private api: PartyApiService) {}

  async findById(
    id: UUID,
    kind: "customer" | "supplier",
    ctx: TenantContext,
  ): Promise<Party | null> {
    void ctx;
    try {
      const dto = await this.api.findById(kind, id);
      return Party.reconstitute(dto as unknown as PartyData);
    } catch (e) {
      if (e instanceof Error && (e as unknown as { statusCode?: number }).statusCode === 404)
        return null;
      if ((e as unknown as { code?: string }).code === "NOT_FOUND") return null;
      throw e;
    }
  }

  async findByCode(
    code: string,
    kind: "customer" | "supplier",
    ctx: TenantContext,
  ): Promise<Party | null> {
    void ctx;
    try {
      const dto = await this.api.findByCode(kind, code);
      return Party.reconstitute(dto as unknown as PartyData);
    } catch (e) {
      if (e instanceof Error && (e as unknown as { statusCode?: number }).statusCode === 404)
        return null;
      if ((e as unknown as { code?: string }).code === "NOT_FOUND") return null;
      throw e;
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
      nextCursor: res.meta?.nextCursor ?? undefined,
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
    const dto = (await this.api.create(
      party.kind,
      wire as Omit<PartyDTO, "id" | "createdAt">,
    )) as unknown as PartyDTO;
    return Party.reconstitute(dto as unknown as PartyData);
  }

  async update(
    id: UUID,
    kind: "customer" | "supplier",
    patch: Partial<Party>,
    ctx: TenantContext,
  ): Promise<Party> {
    const expectedVersion =
      typeof patch.version === "number"
        ? patch.version
        : (await this.findById(id, kind, ctx))?.version;
    if (typeof expectedVersion !== "number") {
      throw new Error("الإصدار المتوقع (expectedVersion) مطلوب لتحديث الحساب");
    }
    const raw = (patch.toJSON ? patch.toJSON() : patch) as Record<string, unknown>;
    const { version: _v, openingBalance: _opening, ...rest } = raw;
    void _opening;
    void _v;
    const dto = await this.api.update(kind, id, {
      ...rest,
      expectedVersion,
    } as Partial<PartyDTO> & { expectedVersion: number });
    return Party.reconstitute(dto as unknown as PartyData);
  }

  async setOpening(
    id: UUID,
    kind: "customer" | "supplier",
    opening: PartyOpeningInput,
    expectedVersion: number,
    ctx: TenantContext,
  ): Promise<Party> {
    void ctx;
    const dto = await this.api.setOpening(kind, id, { opening, expectedVersion });
    return Party.reconstitute(dto as unknown as PartyData);
  }

  async delete(
    id: UUID,
    kind: "customer" | "supplier",
    ctx: TenantContext,
    confirmCascade = false,
    expectedVersion?: number,
  ): Promise<void> {
    // Prefer the version from the deletion-impact sheet (same read the UI just
    // showed). Falling back to `?? 1` was sending version 1 against DB version
    // 2 whenever findById reconstituted a party without a version field —
    // every delete then failed OCC with "الإصدار 2".
    let version =
      typeof expectedVersion === "number" && Number.isFinite(expectedVersion)
        ? expectedVersion
        : undefined;
    if (version === undefined) {
      const current = await this.findById(id, kind, ctx);
      if (!current) return;
      if (typeof current.version !== "number" || !Number.isFinite(current.version)) {
        throw new Error("تعذّر قراءة إصدار السجل — حدّث الصفحة ثم أعد المحاولة");
      }
      version = current.version;
    }
    await this.api.delete(kind, id, version, confirmCascade);
  }
}
