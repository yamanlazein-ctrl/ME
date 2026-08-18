import type {
  IColorRepository,
  ColorFilter,
  CreateColorData,
} from "../../ports/IColorRepository.js";
import type { TenantContext, PaginatedResult } from "../../../domain/types/index.js";
import type { ColorData } from "../../../domain/entities/Color.js";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export async function createColorUseCase(
  repo: IColorRepository,
  input: CreateColorData,
  ctx: TenantContext,
): Promise<Result<ColorData>> {
  try {
    return { ok: true, data: await repo.create(input, ctx) };
  } catch (e) {
    return { ok: false, error: "فشل إنشاء اللون" };
  }
}

export async function updateColorUseCase(
  repo: IColorRepository,
  id: string,
  input: Partial<CreateColorData>,
  ctx: TenantContext,
): Promise<Result<ColorData>> {
  try {
    return { ok: true, data: await repo.update(id, input, ctx) };
  } catch (e) {
    return { ok: false, error: "فشل تحديث اللون" };
  }
}

export async function findColorUseCase(
  repo: IColorRepository,
  id: string,
  ctx: TenantContext,
): Promise<{ ok: true; data: ColorData | null } | { ok: false; error: string }> {
  try {
    return { ok: true, data: await repo.findById(id, ctx) };
  } catch (e) {
    return { ok: false, error: "فشل البحث" };
  }
}

export async function listColorsUseCase(
  repo: IColorRepository,
  filter: ColorFilter,
  ctx: TenantContext,
): Promise<Result<PaginatedResult<ColorData>>> {
  try {
    return { ok: true, data: await repo.list(filter, ctx) };
  } catch (e) {
    return { ok: false, error: "فشل عرض الألوان" };
  }
}

export async function deleteColorUseCase(
  repo: IColorRepository,
  id: string,
  ctx: TenantContext,
): Promise<{ ok: true; data: boolean } | { ok: false; error: string }> {
  try {
    return { ok: true, data: await repo.delete(id, ctx) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "فشل حذف اللون" };
  }
}
