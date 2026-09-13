import type { IReturnRepository, ReturnFilter } from "../../ports/IReturnRepository.js";
import type { TenantContext, PaginatedResult } from "../../../domain/types/index.js";
import type { ReturnData, CreateReturnInput } from "../../../domain/entities/Return.js";
import type { IAuditRepository } from "../../ports/IAuditRepository.js";
import { logAuditError } from "../../../infrastructure/audit/auditErrorHandler.js";
import { BusinessRuleError, DayLockedError } from "../../../domain/errors/index.js";
import { logger } from "../../../infrastructure/config/logger.js";

type Result<T> = { ok: true; data: T } | { ok: false; error: string };

const CLIENT_SAFE_FALLBACK =
  "حدث خطأ، يرجى المحاولة مرة أخرى أو التواصل مع الدعم";

type Collected = { code?: string; message?: string };

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

function looksTechnical(msg: string): boolean {
  return /INSERT|UPDATE|SELECT|DELETE|FROM\s+\w+|constraint|violates|drizzle|postgres|SQLSTATE|Failed query|params:|at\s+\w+\s+\(/i.test(
    msg,
  );
}

/**
 * Never return raw SQL / Postgres / Drizzle text to the client.
 * BusinessRuleError and short Arabic repo messages pass through.
 */
function returnErrorMessage(e: unknown): string {
  if (e instanceof BusinessRuleError) return e.message;
  if (e instanceof DayLockedError) return e.message;

  if (e instanceof Error && e.message && !looksTechnical(e.message)) {
    // Repo still throws plain Error for several Arabic business guards.
    return e.message;
  }

  const errs = collectErrors(e);
  const combined = errs.map((x) => [x.code, x.message].filter(Boolean).join(" ")).join("\n");
  const hasCode = (c: string) => errs.some((x) => x.code === c);

  if (hasCode("23514") || /ledger_entries_type_check/i.test(combined)) {
    return "نوع الحركة المحاسبية غير مسموح به — راجع بيانات المرتجع أو تواصل مع الدعم.";
  }
  if (hasCode("23503") || /foreign key/i.test(combined)) {
    return "بيانات البند غير صالحة: الطرف أو الصبغة المحددة غير موجودة أو محذوفة.";
  }
  if (hasCode("23505")) {
    return "تعذّر حفظ المرتجع بسبب تعارض في البيانات — أعد المحاولة.";
  }
  if (hasCode("23502")) {
    return "حقل إلزامي ناقص في بيانات المرتجع — أكمل جميع الحقول المطلوبة.";
  }
  if (hasCode("22003") || /numeric field overflow/i.test(combined)) {
    return "قيمة الكمية أو السعر خارج النطاق المسموح — راجع الأرقام المدخلة.";
  }

  return CLIENT_SAFE_FALLBACK;
}

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
    logger.error({ err: e, tenantId: ctx.tenantId }, "createReturn failed");
    return { ok: false, error: returnErrorMessage(e) };
  }
}

export async function cancelReturnUseCase(
  repo: IReturnRepository,
  audit: IAuditRepository,
  id: string,
  cancelledBy: string,
  ctx: TenantContext,
  expectedVersion: number,
): Promise<Result<ReturnData>> {
  try {
    // P0-001: optimistic concurrency check
    const current = await repo.findById(id, ctx);
    if (current && current.version !== expectedVersion) {
      return {
        ok: false,
        error: `تعارض في الإصدار: الإصدار الحالي ${current.version}، والإصدار المتوقع ${expectedVersion}. يرجى التحديث والمحاولة مرة أخرى.`,
      };
    }
    const ret = await repo.cancel(id, cancelledBy, ctx, expectedVersion);
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
    logger.error({ err: e, tenantId: ctx.tenantId, returnId: id }, "cancelReturn failed");
    return { ok: false, error: returnErrorMessage(e) };
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
    logger.error({ err: e, tenantId: ctx.tenantId, returnId: id }, "findReturn failed");
    return { ok: false, error: CLIENT_SAFE_FALLBACK };
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
    logger.error({ err: e, tenantId: ctx.tenantId }, "listReturns failed");
    return { ok: false, error: CLIENT_SAFE_FALLBACK };
  }
}
