import type {
  CreatePartyData,
  IPartyRepository,
  PartyFilter,
} from "../../../application/ports/IPartyRepository.js";
import type { TenantContext, PaginatedResult } from "../../../domain/types/index.js";
import type { PartyData } from "../../../domain/entities/Party.js";
import { ValidationError } from "../../../domain/errors/index.js";

type PartyUseCaseResult = { ok: true; data?: PartyData } | { ok: false; error: string };

export async function createPartyUseCase(
  repo: IPartyRepository,
  input: CreatePartyData,
  ctx: TenantContext,
): Promise<PartyUseCaseResult> {
  if (!input.name?.trim()) return { ok: false, error: "الاسم مطلوب" };
  if (!input.kind) return { ok: false, error: "نوع الطرف مطلوب" };

  try {
    const party = await repo.create(input, ctx);
    return { ok: true, data: party };
  } catch (e) {
    return { ok: false, error: "فشل إنشاء الطرف" };
  }
}

export async function updatePartyUseCase(
  repo: IPartyRepository,
  id: string,
  input: Partial<CreatePartyData>,
  ctx: TenantContext,
): Promise<PartyUseCaseResult> {
  try {
    const party = await repo.update(id, input, ctx);
    return { ok: true, data: party };
  } catch (e) {
    return { ok: false, error: "فشل تحديث الطرف" };
  }
}

export async function findPartyUseCase(
  repo: IPartyRepository,
  id: string,
  ctx: TenantContext,
): Promise<{ ok: true; data: PartyData | null } | { ok: false; error: string }> {
  try {
    const party = await repo.findById(id, ctx);
    return { ok: true, data: party };
  } catch (e) {
    return { ok: false, error: "فشل البحث عن الطرف" };
  }
}

export async function listPartiesUseCase(
  repo: IPartyRepository,
  filter: PartyFilter,
  ctx: TenantContext,
): Promise<{ ok: true; data: PaginatedResult<PartyData> } | { ok: false; error: string }> {
  try {
    const result = await repo.list(filter, ctx);
    return { ok: true, data: result };
  } catch (e) {
    return { ok: false, error: "فشل عرض الأطراف" };
  }
}

export async function cancelPartyUseCase(
  repo: IPartyRepository,
  id: string,
  cancelledBy: string,
  ctx: TenantContext,
): Promise<PartyUseCaseResult> {
  try {
    const party = await repo.cancel(id, cancelledBy, ctx);
    return { ok: true, data: party };
  } catch (e) {
    // Surface the repository's clear, business-level message (e.g. "لا يمكن
    // حذف العميل لوجود فواتير مرتبطة به") so the API returns it verbatim.
    return { ok: false, error: e instanceof Error ? e.message : "فشل إلغاء الطرف" };
  }
}
