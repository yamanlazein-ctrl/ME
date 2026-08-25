import type { IReturnRepository, ReturnFilter } from "../../ports/IReturnRepository.js";
import type { TenantContext, PaginatedResult } from "../../../domain/types/index.js";
import type { ReturnData, CreateReturnInput } from "../../../domain/entities/Return.js";
import type { IAuditRepository } from "../../ports/IAuditRepository.js";
import { logAuditError } from "../../../infrastructure/audit/auditErrorHandler.js";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export async function createReturnUseCase(
  repo: IReturnRepository,
  audit: IAuditRepository,
  input: CreateReturnInput,
  ctx: TenantContext,
): Promise<Result<ReturnData>> {
  if (!input.lines?.length) return { ok: false, error: "يجب إضافة بند واحد على الأقل" };
  if (!input.partyId) return { ok: false, error: "الطرف مطلوب" };
  try {
    // Number allocated INSIDE repo.create's transaction — a failed
    // conservation guard (BUG-01/H-1) no longer burns a number.
    const ret = await repo.create(input, ctx);
    audit
      .create({
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        module: "returns",
        action: "create",
        entityType: "return",
        entityId: ret.id,
        detail: `مرتجع ${ret.number}`,
      })
      .catch((err: unknown) =>
        logAuditError(err, {
          module: "returns",
          action: "create",
          entityId: ret.id,
          tenantId: ctx.tenantId,
        }),
      );
    return { ok: true, data: ret };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "فشل إنشاء المرتجع";
    return { ok: false, error: msg };
  }
}

export async function cancelReturnUseCase(
  repo: IReturnRepository,
  audit: IAuditRepository,
  id: string,
  cancelledBy: string,
  ctx: TenantContext,
): Promise<Result<ReturnData>> {
  try {
    const ret = await repo.cancel(id, cancelledBy, ctx);
    audit
      .create({
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        module: "returns",
        action: "cancel",
        entityType: "return",
        entityId: ret.id,
        detail: `إلغاء مرتجع ${ret.number}`,
      })
      .catch((err: unknown) =>
        logAuditError(err, {
          module: "returns",
          action: "cancel",
          entityId: ret.id,
          tenantId: ctx.tenantId,
        }),
      );
    return { ok: true, data: ret };
  } catch (e) {
    const msg = e instanceof Error ? e.message : "فشل إلغاء المرتجع";
    return { ok: false, error: msg };
  }
}

export async function findReturnUseCase(
  repo: IReturnRepository,
  id: string,
  ctx: TenantContext,
): Promise<{ ok: true; data: ReturnData | null } | { ok: false; error: string }> {
  try {
    return { ok: true, data: await repo.findById(id, ctx) };
  } catch (e) {
    return { ok: false, error: "فشل البحث" };
  }
}

export async function listReturnsUseCase(
  repo: IReturnRepository,
  filter: ReturnFilter,
  ctx: TenantContext,
): Promise<Result<PaginatedResult<ReturnData>>> {
  try {
    return { ok: true, data: await repo.list(filter, ctx) };
  } catch (e) {
    return { ok: false, error: "فشل عرض المرتجعات" };
  }
}
