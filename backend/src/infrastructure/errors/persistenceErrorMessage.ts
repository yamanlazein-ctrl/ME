import { BusinessRuleError, DayLockedError } from "../../domain/errors/index.js";

type Collected = { code?: string; message?: string; constraint?: string };

function collectErrors(e: unknown): Collected[] {
  const out: Collected[] = [];
  let cur: unknown = e;
  let guard = 0;
  while (cur && guard++ < 10) {
    if (cur instanceof Error) {
      const ext = cur as Error & { code?: unknown; constraint?: unknown };
      out.push({
        code: typeof ext.code === "string" ? ext.code : undefined,
        message: cur.message,
        constraint: typeof ext.constraint === "string" ? ext.constraint : undefined,
      });
      cur = (cur as Error).cause;
      continue;
    }
    // Drizzle / node-pg sometimes nest a plain object (not Error) with SQLSTATE.
    if (typeof cur === "object") {
      const ext = cur as { code?: unknown; message?: unknown; constraint?: unknown; cause?: unknown };
      out.push({
        code: typeof ext.code === "string" ? ext.code : undefined,
        message: typeof ext.message === "string" ? ext.message : undefined,
        constraint: typeof ext.constraint === "string" ? ext.constraint : undefined,
      });
      cur = ext.cause;
      continue;
    }
    break;
  }
  return out;
}

function errorsCombined(errors: Collected[]): string {
  return errors.map((x) => [x.code, x.constraint, x.message].filter(Boolean).join(" ")).join("\n");
}

function hasCode(errors: Collected[], code: string): boolean {
  return errors.some((x) => x.code === code);
}

export function looksTechnical(msg: string): boolean {
  return /INSERT|UPDATE|SELECT|DELETE|FROM\s+\w+|constraint|violates|drizzle|postgres|SQLSTATE|Failed query|params:|at\s+\w+\s+\(/i.test(
    msg,
  );
}

export type PersistenceContext = "invoice" | "voucher" | "return" | "party" | "generic";

const CONTEXT_LABEL: Record<PersistenceContext, string> = {
  invoice: "الفاتورة",
  voucher: "السند",
  return: "المرتجع",
  party: "الطرف",
  generic: "العملية",
};

/**
 * Map a raw persistence / transaction error to a clear Arabic message.
 * Known business rules pass through verbatim; SQL details stay server-side.
 */
export function persistenceErrorMessage(e: unknown, context: PersistenceContext = "generic"): string {
  if (e instanceof BusinessRuleError) return e.message;
  if (e instanceof DayLockedError) return e.message;

  if (e instanceof Error && e.message && !looksTechnical(e.message)) {
    return e.message;
  }

  const label = CONTEXT_LABEL[context];
  const errs = collectErrors(e);
  const combined = errorsCombined(errs);

  if (hasCode(errs, "23505") || combined.includes("duplicate") || combined.includes("idx_invoices_tenant_type_number")) {
    if (context === "invoice") {
      return "رقم الفاتورة مكرر — فاتورة بهذا الرقم موجودة بالفعل. استخدم رقماً جديداً ثم أعد الحفظ.";
    }
    if (context === "party") {
      if (/idx_parties_tenant_name|parties_tenant_id_name|unique.*name/i.test(combined)) {
        return "اسم العميل/المورد مستخدم مسبقاً — اختر اسماً مختلفاً أو افتح السجل الموجود.";
      }
      if (/idx_parties_tenant_code|parties_tenant_id_code|unique.*code/i.test(combined)) {
        return "رمز العميل/المورد مكرر — اترك الرمز فارغاً ليُنشأ تلقائياً أو استخدم رمزاً آخر.";
      }
      return "تعذّر حفظ الطرف بسبب تعارض في البيانات (اسم أو رمز مكرر) — أعد المحاولة.";
    }
    return `تعذّر حفظ ${label} بسبب تعارض في البيانات — أعد المحاولة.`;
  }
  if (hasCode(errs, "23503") || /foreign key/i.test(combined)) {
    if (/sync_device|sync_outbox_sync_device/i.test(combined)) {
      return "معرّف جهاز المزامنة غير مسجّل — أعد تسجيل الدخول أو أعد تفعيل الجهاز ثم حاول مجدداً.";
    }
    return context === "invoice"
      ? "بيانات البند غير صالحة: المورد، أو القماش، أو اللون، أو الصبغة المحددة غير موجودة أو محذوفة."
      : context === "voucher"
        ? "الطرف أو الفاتورة المرتبطة غير موجودة أو محذوفة — أعد اختيار الطرف والفاتورة."
        : "بيانات البند غير صالحة: الطرف أو الصبغة المحددة غير موجودة أو محذوفة.";
  }
  if (hasCode(errs, "23514") || /ledger_entries_type_check/i.test(combined)) {
    return "نوع الحركة المحاسبية غير مسموح به — راجع الإعدادات أو تواصل مع الدعم.";
  }
  if (
    hasCode(errs, "42703") ||
    /column ["']?discount["']?.*does not exist/i.test(combined)
  ) {
    return "قاعدة البيانات تحتاج ترقية (عمود خصم السندات / أنواع القيود) — شغّل ترحيلات قاعدة البيانات ثم أعد المحاولة.";
  }
  if (hasCode(errs, "23502")) {
    return `حقل إلزامي ناقص في بيانات ${label} — أكمل جميع الحقول المطلوبة.`;
  }
  if (hasCode(errs, "22003") || /numeric field overflow/i.test(combined)) {
    if (context === "party") {
      return "قيمة الضريبة أو الخصم خارج النطاق — أدخل نسبة الضريبة بين 0 و 100.";
    }
    return "قيمة المبلغ أو الكمية خارج النطاق المسموح — راجع الأرقام المدخلة.";
  }
  if (hasCode(errs, "22001")) {
    return "أحد النصوص أطول من الحد المسموح — قصّر الملاحظات أو المرجع.";
  }
  if (hasCode(errs, "22P02")) {
    return "أحد المعرّفات المرسلة غير صالح — أعد فتح الصفحة وحاول مجدداً.";
  }
  if (hasCode(errs, "40P01") || /deadlock/i.test(combined)) {
    return "تعارض مع عملية أخرى على نفس البيانات — أعد المحاولة خلال ثوانٍ.";
  }
  if (hasCode(errs, "42501") || /row-level security|permission denied/i.test(combined)) {
    return "صلاحية الوصول للبيانات مرفوضة — أعد تسجيل الدخول أو راجع صلاحيات المستخدم.";
  }
  if (/unbalanced|debit.*credit|chk_ledger/i.test(combined)) {
    return "القيد المحاسبي غير متوازن — راجع المبالغ والخصم ثم أعد الحفظ.";
  }

  return `تعذّر حفظ ${label} بسبب خطأ غير متوقع — أعد المحاولة، وإذا تكرر الأمر راجع مسؤول النظام.`;
}

/** F-07 transaction wrapper: prefer the real failure reason over a generic sync message. */
export function transactionFailureMessage(
  e: unknown,
  context: PersistenceContext,
  syncFallback: string,
): string {
  if (e instanceof BusinessRuleError || e instanceof DayLockedError) {
    return e.message;
  }
  const mapped = persistenceErrorMessage(e, context);
  const generic = CONTEXT_LABEL[context];
  if (mapped.includes("غير متوقع") && syncFallback) {
    return `${syncFallback} (${mapped.replace(`تعذّر حفظ ${generic} بسبب `, "")})`;
  }
  return mapped;
}
