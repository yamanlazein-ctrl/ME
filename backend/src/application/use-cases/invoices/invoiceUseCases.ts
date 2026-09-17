import type { IInvoiceRepository, InvoiceFilter } from "../../ports/IInvoiceRepository.js";
import type { TenantContext, PaginatedResult } from "../../../domain/types/index.js";
import type {
  InvoiceData,
  CreateInvoiceInput,
  UpdateInvoiceInput,
} from "../../../domain/entities/Invoice.js";
import type { IAuditRepository } from "../../ports/IAuditRepository.js";
import { logAuditError } from "../../../infrastructure/audit/auditErrorHandler.js";
import { DayLockedError, BusinessRuleError } from "../../../domain/errors/index.js";
import { logger } from "../../../infrastructure/config/logger.js";
import { persistenceErrorMessage } from "../../../infrastructure/errors/persistenceErrorMessage.js";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

/**
 * Compact invoice snapshot for the audit trail (invoice-tracking feature):
 * captures exactly the fields an operator would want to diff — number, date,
 * currency, status, money fields and per-line qty/price — without dumping
 * whole row payloads into audit_logs. Stored in before_snapshot/after_snapshot.
 */
function invoiceAuditSnapshot(inv: InvoiceData) {
  return {
    number: inv.number,
    date: inv.date,
    currency: inv.currency,
    status: inv.status,
    discount: inv.discount ?? 0,
    tax: inv.tax ?? 0,
    total: inv.total,
    lines: (inv.lines ?? []).map((l) => ({
      rollId: l.rollId,
      quantityKg: l.quantityKg,
      pricePerKg: l.pricePerKg,
      pieces: l.pieces ?? 1,
    })),
  };
}

function invoiceErrorMessage(e: unknown): string {
  return persistenceErrorMessage(e, "invoice");
}

export async function createInvoiceUseCase(
  repo: IInvoiceRepository,
  audit: IAuditRepository,
  input: CreateInvoiceInput,
  ctx: TenantContext,
): Promise<Result<InvoiceData>> {
  if (!input.lines?.length) return { ok: false, error: "يجب إضافة بند واحد على الأقل" };
  if (!input.partyId) return { ok: false, error: "الطرف مطلوب" };
  try {
    // Document number is allocated INSIDE repo.create (same transaction as
    // the insert). A failed save rolls back the sequence increment, so
    // a validation error or FK violation does not burn a number.
    const invoice = await repo.create(input, ctx);
    audit
      .create({
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        actorName: ctx.userName,
        module: "invoices",
        action: "create",
        entityType: "invoice",
        entityId: invoice.id,
        detail: `فاتورة ${invoice.number}`,
        afterSnapshot: invoiceAuditSnapshot(invoice),
      })
      .catch((err: unknown) =>
        logAuditError(err, {
          module: "invoices",
          action: "create",
          entityId: invoice.id,
          tenantId: ctx.tenantId,
        }),
      );
    return { ok: true, data: invoice };
  } catch (e) {
    // Full technical details logged to the file (pino) for diagnosis; only a
    // clear Arabic message reaches the caller/UI. A known BusinessRuleError is
    // logged at warn (audit trail) with its exact message.
    if (e instanceof BusinessRuleError) {
      logger.warn({ err: e.message }, "[createInvoiceUseCase] business rule violation");
    } else {
      logger.error({ err: e }, "[createInvoiceUseCase] failed");
    }
    return { ok: false, error: invoiceErrorMessage(e) };
  }
}

export async function updateInvoiceUseCase(
  repo: IInvoiceRepository,
  audit: IAuditRepository,
  id: string,
  input: UpdateInvoiceInput,
  ctx: TenantContext,
  expectedVersion: number,
): Promise<Result<InvoiceData> & { code?: string }> {
  if (!input.lines?.length) return { ok: false, error: "يجب إضافة بند واحد على الأقل", code: "VALIDATION" };
  try {
    // Fetch the pre-edit state first so the audit trail can show exactly
    // what changed (invoice-tracking feature).
    const before = await repo.findById(id, ctx);
    // P0-001: optimistic concurrency check — expectedVersion is REQUIRED
    if (before && before.version !== expectedVersion) {
      return {
        ok: false,
        error: `تعارض في الإصدار: الإصدار الحالي ${before.version}، والإصدار المتوقع ${expectedVersion}. يرجى التحديث والمحاولة مرة أخرى.`,
        code: "STALE_VERSION",
      };
    }
    const invoice = await repo.update(id, input, ctx, expectedVersion);
    audit
      .create({
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        actorName: ctx.userName,
        module: "invoices",
        action: "update",
        entityType: "invoice",
        entityId: invoice.id,
        detail: `تعديل فاتورة ${invoice.number}`,
        beforeSnapshot: before ? invoiceAuditSnapshot(before) : undefined,
        afterSnapshot: invoiceAuditSnapshot(invoice),
      })
      .catch((err: unknown) =>
        logAuditError(err, {
          module: "invoices",
          action: "update",
          entityId: invoice.id,
          tenantId: ctx.tenantId,
        }),
      );
    return { ok: true, data: invoice };
  } catch (e) {
    if (e instanceof BusinessRuleError) {
      logger.warn({ err: e.message }, "[updateInvoiceUseCase] business rule violation");
    } else {
      logger.error({ err: e }, "[updateInvoiceUseCase] failed");
    }
    const code =
      e instanceof Error && "code" in e ? (e as { code?: string }).code : undefined;
    if (code === "NOT_FOUND") return { ok: false, error: "الفاتورة غير موجودة.", code };
    if (code === "ALREADY_CANCELLED")
      return { ok: false, error: "لا يمكن تعديل فاتورة ملغاة.", code };
    if (code === "STALE_VERSION")
      return { ok: false, error: "تعارض في الإصدار: تم تعديل الفاتورة من قبل جهاز آخر. يرجى التحديث والمحاولة مرة أخرى.", code };
    return { ok: false, error: invoiceErrorMessage(e), code };
  }
}

export async function cancelInvoiceUseCase(
  repo: IInvoiceRepository,
  audit: IAuditRepository,
  id: string,
  cancelledBy: string,
  ctx: TenantContext,
  expectedVersion: number,
): Promise<Result<InvoiceData> & { code?: string }> {
  try {
    // P0-001: optimistic concurrency check — fetch current state first
    const current = await repo.findById(id, ctx);
    if (current && current.version !== expectedVersion) {
      return {
        ok: false,
        error: `تعارض في الإصدار: الإصدار الحالي ${current.version}، والإصدار المتوقع ${expectedVersion}. يرجى التحديث والمحاولة مرة أخرى.`,
        code: "STALE_VERSION",
      };
    }
    const invoice = await repo.cancel(id, cancelledBy, ctx, expectedVersion);
    audit
      .create({
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        actorName: ctx.userName,
        module: "invoices",
        action: "cancel",
        entityType: "invoice",
        entityId: invoice.id,
        detail: `إلغاء فاتورة ${invoice.number}`,
        beforeSnapshot: invoiceAuditSnapshot(invoice),
      })
      .catch((err: unknown) =>
        logAuditError(err, {
          module: "invoices",
          action: "cancel",
          entityId: invoice.id,
          tenantId: ctx.tenantId,
        }),
      );
    return { ok: true, data: invoice };
  } catch (e) {
    if (e instanceof BusinessRuleError) {
      logger.warn({ err: e.message }, "[cancelInvoiceUseCase] business rule violation");
      return { ok: false, error: e.message, code: "BUSINESS_RULE" };
    }
    logger.error({ err: e }, "[cancelInvoiceUseCase] failed");
    // TX11: surface the structured code so the route can map NOT_FOUND → 404.
    const code = e instanceof Error && "code" in e ? (e as { code?: string }).code : undefined;
    if (code === "NOT_FOUND") return { ok: false, error: "الفاتورة غير موجودة.", code };
    if (code === "INVALID_STATE" || code === "ALREADY_CANCELLED") {
      return { ok: false, error: "لا يمكن إلغاء هذه الفاتورة في حالتها الحالية.", code };
    }
    if (code === "STALE_VERSION") {
      return { ok: false, error: "تعارض في الإصدار: تم تعديل الفاتورة من قبل جهاز آخر. يرجى التحديث والمحاولة مرة أخرى.", code };
    }
    return { ok: false, error: "تعذّر إلغاء الفاتورة بسبب خطأ داخلي. أعد المحاولة.", code };
  }
}

export async function findInvoiceUseCase(
  repo: IInvoiceRepository,
  id: string,
  ctx: TenantContext,
): Promise<{ ok: true; data: InvoiceData | null } | { ok: false; error: string }> {
  try {
    return { ok: true, data: await repo.findById(id, ctx) };
  } catch (e) {
    return { ok: false, error: "فشل البحث" };
  }
}

export async function findInvoiceByNumberUseCase(
  repo: IInvoiceRepository,
  number: string,
  type: string,
  ctx: TenantContext,
): Promise<{ ok: true; data: InvoiceData | null } | { ok: false; error: string }> {
  try {
    return { ok: true, data: await repo.findByNumber(number, type, ctx) };
  } catch (e) {
    return { ok: false, error: "فشل البحث" };
  }
}

export async function listInvoicesUseCase(
  repo: IInvoiceRepository,
  filter: InvoiceFilter,
  ctx: TenantContext,
): Promise<Result<PaginatedResult<InvoiceData>>> {
  try {
    return { ok: true, data: await repo.list(filter, ctx) };
  } catch (e) {
    return { ok: false, error: "فشل عرض الفواتير" };
  }
}
