import type { IVoucherRepository, VoucherFilter } from "../../ports/IVoucherRepository.js";
import type { TenantContext, PaginatedResult } from "../../../domain/types/index.js";
import type { VoucherData, CreateVoucherInput } from "../../../domain/entities/Voucher.js";
import type { IAuditRepository } from "../../ports/IAuditRepository.js";
import { logAuditError } from "../../../infrastructure/audit/auditErrorHandler.js";
import {
  BusinessRuleError,
  DayLockedError,
  InsufficientCashboxBalanceError,
} from "../../../domain/errors/index.js";
import { persistenceErrorMessage } from "../../../infrastructure/errors/persistenceErrorMessage.js";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

export async function createVoucherUseCase(
  repo: IVoucherRepository,
  audit: IAuditRepository,
  input: CreateVoucherInput,
  ctx: TenantContext,
): Promise<Result<VoucherData>> {
  const cash = input.amount ?? 0;
  const discount = input.discount ?? 0;
  if (cash < 0) return { ok: false, error: "المبلغ النقدي لا يمكن أن يكون سالباً" };
  if (discount < 0) return { ok: false, error: "الخصم لا يمكن أن يكون سالباً" };
  if (cash + discount <= 0)
    return { ok: false, error: "يجب أن يكون مجموع المبلغ النقدي والمسامحة أكبر من صفر" };
  if (!input.partyId) return { ok: false, error: "الطرف مطلوب" };
  try {
    // Document number is allocated INSIDE repo.create (same transaction as
    // the insert and the ledger double-entry). A failed guard — over-
    // collection, cross-currency, cancelled invoice — rolls back the
    // sequence increment too, so no number is burned.
    const voucher = await repo.create(input, ctx);
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
      .catch((err: unknown) =>
        logAuditError(err, {
          module: "vouchers",
          action: "create",
          entityId: voucher.id,
          tenantId: ctx.tenantId,
        }),
      );
    return { ok: true, data: voucher };
  } catch (e) {
    if (e instanceof DayLockedError) return { ok: false, error: e.message };
    // F06: insufficient cashbox balance for a cash payment voucher.
    if (e instanceof InsufficientCashboxBalanceError) return { ok: false, error: e.message };
    // Business rules (cross-currency, over-collection, cancelled invoice…) are
    // already user-safe Arabic messages from the repository guards — pass them
    // through verbatim instead of masking them as "internal errors".
    if (e instanceof BusinessRuleError) return { ok: false, error: e.message };
    // F4 (audit fix): raw JS errors (e.g. ReferenceError on a TDZ) are not actionable
    // for the user. Log the full error server-side and return a generic Arabic message.
    const err = e instanceof Error ? e : new Error(String(e));
    logAuditError(err, {
      module: "vouchers",
      action: "create",
      // No voucher id exists yet on failure (numbering happens inside
      // repo.create's transaction); fall back to the linked invoice id.
      entityId: input.invoiceId ?? "unknown",
      tenantId: ctx.tenantId,
    });
    return { ok: false, error: persistenceErrorMessage(e, "voucher") };
  }
}

export async function cancelVoucherUseCase(
  repo: IVoucherRepository,
  audit: IAuditRepository,
  id: string,
  cancelledBy: string,
  ctx: TenantContext,
  expectedVersion: number,
): Promise<Result<VoucherData>> {
  try {
    // P0-001: optimistic concurrency check
    const current = await repo.findById(id, ctx);
    if (current && current.version !== expectedVersion) {
      return {
        ok: false,
        error: `تعارض في الإصدار: الإصدار الحالي ${current.version}، والإصدار المتوقع ${expectedVersion}. يرجى التحديث والمحاولة مرة أخرى.`,
      };
    }
    const voucher = await repo.cancel(id, cancelledBy, ctx, expectedVersion);
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
      .catch((err: unknown) =>
        logAuditError(err, {
          module: "vouchers",
          action: "cancel",
          entityId: voucher.id,
          tenantId: ctx.tenantId,
        }),
      );
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
