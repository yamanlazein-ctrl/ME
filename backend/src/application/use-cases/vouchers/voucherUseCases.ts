import type { IVoucherRepository, VoucherFilter } from "../../ports/IVoucherRepository.js";
import type { TenantContext, PaginatedResult } from "../../../domain/types/index.js";
import type { VoucherData, CreateVoucherInput } from "../../../domain/entities/Voucher.js";
import type { IAuditRepository } from "../../ports/IAuditRepository.js";
import { logAuditError } from "../../../infrastructure/audit/auditErrorHandler.js";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export async function createVoucherUseCase(
  repo: IVoucherRepository,
  audit: IAuditRepository,
  input: CreateVoucherInput,
  autoNumber: string,
  ctx: TenantContext,
): Promise<Result<VoucherData>> {
  if (!input.amount || input.amount <= 0)
    return { ok: false, error: "المبلغ يجب أن يكون أكبر من صفر" };
  if (!input.partyId) return { ok: false, error: "الطرف مطلوب" };
  try {
    const voucher = await repo.create(input, autoNumber, ctx);
    audit
      .create({
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        module: "vouchers",
        action: "create",
        entityType: "voucher",
        entityId: voucher.id,
        detail: `سند ${voucher.kind === "receipt" ? "قبض" : "صرف"} ${voucher.number}`,
      })
      .catch((err: unknown) => logAuditError(err, { module: "vouchers", action: "create", entityId: voucher.id, tenantId: ctx.tenantId }));
    return { ok: true, data: voucher };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "فشل إنشاء السند" };
  }
}

export async function cancelVoucherUseCase(
  repo: IVoucherRepository,
  audit: IAuditRepository,
  id: string,
  cancelledBy: string,
  ctx: TenantContext,
): Promise<Result<VoucherData>> {
  try {
    const voucher = await repo.cancel(id, cancelledBy, ctx);
    audit
      .create({
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        module: "vouchers",
        action: "cancel",
        entityType: "voucher",
        entityId: voucher.id,
        detail: `إلغاء سند ${voucher.number}`,
      })
      .catch((err: unknown) => logAuditError(err, { module: "vouchers", action: "cancel", entityId: voucher.id, tenantId: ctx.tenantId }));
    return { ok: true, data: voucher };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : "فشل إلغاء السند" };
  }
}

export async function findVoucherUseCase(
  repo: IVoucherRepository,
  id: string,
  ctx: TenantContext,
): Promise<{ ok: true; data: VoucherData | null } | { ok: false; error: string }> {
  try {
    return { ok: true, data: await repo.findById(id, ctx) };
  } catch (e) {
    return { ok: false, error: "فشل البحث" };
  }
}

export async function listVouchersUseCase(
  repo: IVoucherRepository,
  filter: VoucherFilter,
  ctx: TenantContext,
): Promise<Result<PaginatedResult<VoucherData>>> {
  try {
    return { ok: true, data: await repo.list(filter, ctx) };
  } catch (e) {
    return { ok: false, error: "فشل عرض السندات" };
  }
}
