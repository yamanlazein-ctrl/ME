import type {
  IFabricRepository,
  FabricFilter,
  CreateFabricData,
} from "../../ports/IFabricRepository.js";
import type { TenantContext, PaginatedResult } from "../../../domain/types/index.js";
import type { FabricData } from "../../../domain/entities/Fabric.js";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export async function createFabricUseCase(
  repo: IFabricRepository,
  input: CreateFabricData,
  ctx: TenantContext,
): Promise<Result<FabricData>> {
  try {
    return { ok: true, data: await repo.create(input, ctx) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "";
    if (msg.includes("duplicate key") || msg.includes("idx_fabrics_tenant_name")) {
      return { ok: false, error: "يوجد قماش بنفس الاسم بالفعل." };
    }
    return { ok: false, error: "فشل إنشاء القماش" };
  }
}

export async function updateFabricUseCase(
  repo: IFabricRepository,
  id: string,
  input: Partial<CreateFabricData>,
  ctx: TenantContext,
): Promise<Result<FabricData>> {
  try {
    return { ok: true, data: await repo.update(id, input, ctx) };
  } catch (e) {
    return { ok: false, error: "فشل تحديث القماش" };
  }
}

export async function findFabricUseCase(
  repo: IFabricRepository,
  id: string,
  ctx: TenantContext,
): Promise<{ ok: true; data: FabricData | null } | { ok: false; error: string }> {
  try {
    return { ok: true, data: await repo.findById(id, ctx) };
  } catch (e) {
    return { ok: false, error: "فشل البحث" };
  }
}

export async function listFabricsUseCase(
  repo: IFabricRepository,
  filter: FabricFilter,
  ctx: TenantContext,
): Promise<Result<PaginatedResult<FabricData>>> {
  try {
    return { ok: true, data: await repo.list(filter, ctx) };
  } catch (e) {
    return { ok: false, error: "فشل عرض الأقمشة" };
  }
}

export async function deleteFabricUseCase(
  repo: IFabricRepository,
  id: string,
  ctx: TenantContext,
): Promise<{ ok: true; data: boolean } | { ok: false; error: string }> {
  try {
    return { ok: true, data: await repo.delete(id, ctx) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "فشل حذف القماش" };
  }
}
