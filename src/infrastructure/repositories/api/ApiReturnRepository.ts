import { TenantContext, UUID, type PaginatedResult } from "@/domain/types";
import type {
  IReturnRepository,
  ReturnFilter,
  CreateReturnInput,
} from "@/application/ports/IReturnRepository";
import type {
  ReturnDTO,
  ReturnKind,
  ReturnReason,
  ReturnLineDTO,
} from "@/application/ports/IReturnRepository";
import type { ReturnDTO as ContractReturnDTO, CreateReturnRequest } from "@/contracts/returns";
import { ReturnApiService } from "@/infrastructure/api";

function toPortReturn(dto: ContractReturnDTO): ReturnDTO {
  return {
    id: dto.id as UUID,
    tenantId: "" as UUID,
    number: dto.number,
    kind: dto.kind as ReturnKind,
    date: dto.date,
    partyId: dto.partyId as UUID,
    originalInvoiceId: dto.originalInvoiceId as UUID | null | undefined,
    lines: dto.lines.map((l) => ({
      id: l.id as UUID,
      rollId: l.rollId as UUID,
      quantityKg: l.quantityKg,
      pieces: l.pieces ?? 1,
      pricePerKg: l.pricePerKg,
    })),
    reason: dto.reason as ReturnReason,
    currency: dto.currency,
    notesPrint: dto.notesPrint ?? null,
    notesInternal: dto.notesInternal ?? null,
    status: dto.status as "active" | "cancelled",
    createdAt: dto.createdAt,
    createdBy: dto.createdBy,
    cancelledAt: dto.cancelledAt ?? null,
    cancelledBy: dto.cancelledBy ?? null,
  };
}

export class ApiReturnRepository implements IReturnRepository {
  constructor(private api: ReturnApiService) {}

  async findById(id: UUID, ctx: TenantContext): Promise<ReturnDTO | null> {
    try {
      const dto = await this.api.findById(id);
      return toPortReturn(dto);
    } catch (e) {
      console.warn("[ApiRepo] Return findById failed", e);
      return null;
    }
  }

  async list(filter: ReturnFilter, ctx: TenantContext): Promise<PaginatedResult<ReturnDTO>> {
    const res = await this.api.list(filter);
    const data = res.data.map(toPortReturn);
    return { data, total: res.meta.total, hasNext: res.meta.hasNext };
  }

  async create(input: CreateReturnInput, ctx: TenantContext): Promise<ReturnDTO> {
    const req: CreateReturnRequest = {
      kind: input.kind,
      date: input.date,
      partyId: input.partyId,
      originalInvoiceId: input.originalInvoiceId,
      lines: input.lines.map((l) => ({
        rollId: l.rollId,
        quantityKg: l.quantityKg,
        pieces: l.pieces ?? 1,
        pricePerKg: l.pricePerKg,
      })),
      reason: input.reason,
      currency: input.currency,
      notesPrint: input.notesPrint,
      notesInternal: input.notesInternal,
    };
    const dto = await this.api.create(req);
    return toPortReturn(dto);
  }

  async cancel(id: UUID, ctx: TenantContext): Promise<void> {
    await this.api.cancel(id);
  }
}
