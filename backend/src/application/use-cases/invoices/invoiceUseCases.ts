import type { IInvoiceRepository, InvoiceFilter } from "../../ports/IInvoiceRepository.js";
import type { TenantContext, PaginatedResult } from "../../../domain/types/index.js";
import type { InvoiceData, CreateInvoiceInput } from "../../../domain/entities/Invoice.js";
import type { IAuditRepository } from "../../ports/IAuditRepository.js";
import { logAuditError } from "../../../infrastructure/audit/auditErrorHandler.js";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

type Collected = { code?: string; message?: string };

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
  const errs = collectErrors(e);
  const combined = errorsCombined(errs);
  const hasCode = (c: string) => hasErrorCode(errs, c);

  // 23505 unique_violation (invoices.tenant_id, type, number)
  if (hasCode("23505") || combined.includes("duplicate") || combined.includes("idx_invoices_tenant_type_number")) {
    return "رقم الفاتورة مكرر — فاتورة بهذا الرقم موجودة بالفعل. استخدم رقماً جديداً ثم أعد الحفظ.";
  }
  // 23503 foreign_key_violation
  if (hasCode("23503") || combined.includes("foreign key")) {
    return "بيانات البند غير صالحة: المورد، أو القماش، أو اللون، أو الصبغة المحددة غير موجودة أو محذوفة.";
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
  autoNumber: string,
  ctx: TenantContext,
): Promise<Result<InvoiceData>> {
  if (!input.lines?.length) return { ok: false, error: "يجب إضافة بند واحد على الأقل" };
  if (!input.partyId) return { ok: false, error: "الطرف مطلوب" };
  try {
    const invoice = await repo.create(input, autoNumber, ctx);
    audit
      .create({
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        module: "invoices",
        action: "create",
        entityType: "invoice",
        entityId: invoice.id,
        detail: `فاتورة ${invoice.number}`,
      })
      .catch((err: unknown) => logAuditError(err, { module: "invoices", action: "create", entityId: invoice.id, tenantId: ctx.tenantId }));
    return { ok: true, data: invoice };
  } catch (e) {
    // Full technical details logged for diagnosis; only a clear Arabic
    // message reaches the caller/UI.
    console.error("[createInvoiceUseCase] failed:", collectErrors(e));
    return { ok: false, error: invoiceErrorMessage(e) };
  }
}

export async function cancelInvoiceUseCase(
  repo: IInvoiceRepository,
  audit: IAuditRepository,
  id: string,
  cancelledBy: string,
  ctx: TenantContext,
): Promise<Result<InvoiceData> & { code?: string }> {
  try {
    const invoice = await repo.cancel(id, cancelledBy, ctx);
    audit
      .create({
        tenantId: ctx.tenantId,
        actorId: ctx.userId,
        module: "invoices",
        action: "cancel",
        entityType: "invoice",
        entityId: invoice.id,
        detail: `إلغاء فاتورة ${invoice.number}`,
      })
      .catch((err: unknown) => logAuditError(err, { module: "invoices", action: "cancel", entityId: invoice.id, tenantId: ctx.tenantId }));
    return { ok: true, data: invoice };
  } catch (e) {
    console.error("[cancelInvoiceUseCase] failed:", e);
    // TX11: surface the structured code so the route can map NOT_FOUND → 404.
    const code = e instanceof Error && "code" in e ? (e as { code?: string }).code : undefined;
    if (code === "NOT_FOUND") return { ok: false, error: "الفاتورة غير موجودة.", code };
    if (code === "INVALID_STATE" || code === "ALREADY_CANCELLED") {
      return { ok: false, error: "لا يمكن إلغاء هذه الفاتورة في حالتها الحالية.", code };
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
