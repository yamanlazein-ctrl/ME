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

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

type Collected = { code?: string; message?: string };

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

/**
 * Walk an error and its `cause` chain to collect Postgres/Drizzle error
 * codes + messages. Drizzle wraps the real pg error in `cause`, so we must
 * inspect the full chain to find the SQLSTATE `code` (e.g. "23505").
 */
function collectErrors(e: unknown): Collected[] {
  const out: Collected[] = [];
  let cur: unknown = e;
  let guard = 0;
  while (cur && guard++ < 10) {
    if (!(cur instanceof Error)) break;
    const codeRaw = (cur as Error & { code?: unknown }).code;
    out.push({
      code: typeof codeRaw === "string" ? codeRaw : undefined,
      message: cur.message,
    });
    cur = (cur as Error).cause;
  }
  return out;
}

function hasErrorCode(errors: Collected[], code: string): boolean {
  return errors.some((x) => x.code === code);
}

function errorsCombined(errors: Collected[]): string {
  return errors.map((x) => [x.code, x.message].filter(Boolean).join(" ")).join("\n");
}

/**
 * Map a raw persistence error to a clear, non-misleading Arabic message.
 * Technical SQL/Drizzle details are NEVER returned to the user — they are
 * logged server-side (caller) for diagnosis instead.
 */
function invoiceErrorMessage(e: unknown): string {
  // A known business-rule violation carries the precise, actionable Arabic
  // reason already — return it verbatim instead of masking it. Everything
  // else is an unexpected fault (mapped to the generic "internal error"
  // below and logged server-side).
  if (e instanceof BusinessRuleError) return e.message;
  if (e instanceof DayLockedError) return e.message;
  const errs = collectErrors(e);
  const combined = errorsCombined(errs);
  const hasCode = (c: string) => hasErrorCode(errs, c);

  // 23505 unique_violation (invoices.tenant_id, type, number)
  if (
    hasCode("23505") ||
    combined.includes("duplicate") ||
    combined.includes("idx_invoices_tenant_type_number")
  ) {
    return "رقم الفاتورة مكرر — فاتورة بهذا الرقم موجودة بالفعل. استخدم رقماً جديداً ثم أعد الحفظ.";
  }
  // 23503 foreign_key_violation
  if (hasCode("23503") || combined.includes("foreign key")) {
    return "بيانات البند غير صالحة: المورد، أو القماش، أو اللون، أو الصبغة المحددة غير موجودة أو محذوفة.";
  }
  // 23514 check_violation (e.g. ledger_entries.type)
  if (hasCode("23514")) {
    return "نوع الحركة المحاسبية غير مسموح به — راجع بيانات الفاتورة أو تواصل مع الدعم.";
  }
  // 23502 not_null_violation
  if (hasCode("23502")) {
    return "حقل إلزامي ناقص في بيانات الفاتورة — أكمل جميع الحقول المطلوبة.";
  }
  // 22003 / 22001 / 22P02 numeric/truncation/invalid-identifier
  if (hasCode("22003") || combined.includes("numeric field overflow")) {
    return "قيمة الكمية أو السعر خارج النطاق المسموح — راجع الأرقام المدخلة.";
  }
  if (hasCode("22001")) {
    return "أحد النصوص (اسم القماش، المرجع، أو الملاحظات) أطول من الحد المسموح.";
  }
  if (hasCode("22P02")) {
    return "أحد المعرّفات المرسلة غير صالح — أعد فتح الصفحة وحاول مجدداً.";
  }
  return "تعذّر حفظ الفاتورة بسبب خطأ داخلي. أعد المحاولة، وإذا تكرر الأمر راجع مسؤول النظام.";
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
      logger.error({ err: collectErrors(e) }, "[createInvoiceUseCase] failed");
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
      logger.error({ err: collectErrors(e) }, "[updateInvoiceUseCase] failed");
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
    logger.error({ err: collectErrors(e) }, "[cancelInvoiceUseCase] failed");
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
