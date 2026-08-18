import type { IRollRepository, RollFilter, CreateRollData } from "../../ports/IRollRepository.js";
import type { TenantContext, PaginatedResult } from "../../../domain/types/index.js";
import type { RollData } from "../../../domain/entities/Roll.js";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export async function createRollUseCase(
  repo: IRollRepository,
  input: CreateRollData,
  ctx: TenantContext,
): Promise<Result<RollData>> {
  try {
    return { ok: true, data: await repo.create(input, ctx) };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    const cause = e instanceof Error && e.cause instanceof Error ? e.cause.message : "";
    const stack = e instanceof Error ? e.stack : "";
    return {
      ok: false,
      error: `DIAG :: ${msg} || CAUSE=${cause} || STACK=${String(stack).split("\n").slice(0, 4).join(" / ")}`,
    };
  }
}

export async function updateRollUseCase(
  repo: IRollRepository,
  id: string,
  input: Partial<CreateRollData>,
  ctx: TenantContext,
): Promise<Result<RollData>> {
  try {
    return { ok: true, data: await repo.update(id, input, ctx) };
  } catch (e) {
    return { ok: false, error: "فشل تحديث الصبغة" };
  }
}

export async function findRollUseCase(
  repo: IRollRepository,
  id: string,
  ctx: TenantContext,
): Promise<{ ok: true; data: RollData | null } | { ok: false; error: string }> {
  try {
    return { ok: true, data: await repo.findById(id, ctx) };
  } catch (e) {
    return { ok: false, error: "فشل البحث" };
  }
}

export async function listRollsUseCase(
  repo: IRollRepository,
  filter: RollFilter,
  ctx: TenantContext,
): Promise<Result<PaginatedResult<RollData>>> {
  try {
    return { ok: true, data: await repo.list(filter, ctx) };
  } catch (e) {
    return { ok: false, error: "فشل عرض الصبغات" };
  }
}

export async function deleteRollUseCase(
  repo: IRollRepository,
  id: string,
  ctx: TenantContext,
): Promise<{ ok: true; data: boolean } | { ok: false; error: string }> {
  try {
    return { ok: true, data: await repo.delete(id, ctx) };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "فشل حذف الصبغة" };
  }
}
