/**
 * Domain errors — typed error classes for business failures.
 */

export class DomainError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = this.constructor.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class ValidationError extends DomainError {
  constructor(public readonly details: Record<string, string[]>) {
    super("VALIDATION_ERROR", "البيانات المدخلة غير صحيحة");
  }
}

export class NotFoundError extends DomainError {
  constructor(entity: string, id?: string) {
    super("NOT_FOUND", `${entity}${id ? ` (${id})` : ""} غير موجود`);
  }
}

export class AuthError extends DomainError {
  constructor(code: string, message: string) {
    super(code, message);
  }
}

export class InvalidPinError extends AuthError {
  constructor() {
    super("INVALID_PIN", "الرقم السري غير صحيح");
  }
}

export class InvalidCredentialsError extends AuthError {
  constructor() {
    super("INVALID_CREDENTIALS", "البريد الإلكتروني أو كلمة المرور غير صحيحة");
  }
}

export class TokenExpiredError extends AuthError {
  constructor() {
    super("TOKEN_EXPIRED", "انتهت صلاحية الجلسة");
  }
}

export class ForbiddenError extends DomainError {
  constructor(message = "غير مصرح بهذا الإجراء") {
    super("FORBIDDEN", message);
  }
}

export class ConflictError extends DomainError {
  constructor(message: string) {
    super("CONFLICT", message);
  }
}

export class ConcurrencyError extends DomainError {
  constructor(entity: string, id: string) {
    super(
      "CONCURRENT_MODIFICATION",
      `${entity} ${id} تم تعديله بواسطة طلب آخر. يرجى المحاولة مرة أخرى.`,
    );
  }
}

export class InsufficientStockError extends DomainError {
  constructor(
    public readonly rollId: string,
    public readonly requested: number,
    public readonly available: number,
  ) {
    super(
      "INSUFFICIENT_STOCK",
      `رقم الرول ${rollId}: الكمية المطلوبة ${requested}، المتاح ${available} فقط.`,
    );
  }
}

export class InvalidStatusTransitionError extends DomainError {
  constructor(entity: string, from: string, to: string) {
    super("INVALID_STATE", `لا يمكن تغيير حالة ${entity} من ${from} إلى ${to}`);
  }
}

export class DayLockedError extends DomainError {
  constructor(date: string) {
    super("DAY_LOCKED", `اليوم ${date} مغلق ولا يمكن إجراء حركات عليه`);
  }
}

export class DuplicateDocumentError extends DomainError {
  constructor(docType: string, number: string) {
    super("DUPLICATE", `${docType} برقم ${number} موجود بالفعل`);
  }
}

/**
 * Known business-rule violation. Thrown by the invoice repository when a
 * request breaks a domain rule (color must match the roll, fabric must match,
 * entry quantity delta must not exceed the roll's unsold stock, etc.).
 *
 * The catch layer in invoiceUseCases checks `instanceof BusinessRuleError`
 * FIRST and returns `e.message` verbatim to the user — because this text is
 * the precise, actionable reason. Anything that is NOT a BusinessRuleError is
 * treated as an unexpected programming fault: logged to the file and masked
 * behind the generic "internal error" message.
 */
export class BusinessRuleError extends DomainError {
  constructor(message: string) {
    super("BUSINESS_RULE", message);
  }
}

export class RateLimitExceededError extends DomainError {
  constructor() {
    super("RATE_LIMIT_EXCEEDED", "تم تجاوز الحد المسموح من الطلبات. يرجى المحاولة لاحقاً");
  }
}

/**
 * StoneERP is single-tenant-per-install: every database should contain at
 * most one company/tenant (see docs/decisions.md). `findAnyCompleted()`
 * used to pick an arbitrary completed tenant when more than one existed,
 * which let a brand-new license activation silently bind to a different,
 * pre-existing company's tenant (forensic audit finding F01). Finding more
 * than one completed tenant means the single-tenant invariant has already
 * been violated (e.g. a cloned/template database, or a prior run of this
 * same bug) — that must fail loudly for an operator to resolve, never be
 * silently picked around.
 */
export class MultipleTenantsDetectedError extends DomainError {
  constructor() {
    super(
      "MULTIPLE_TENANTS_DETECTED",
      "تم العثور على أكثر من مستأجر واحد مكتمل في قاعدة البيانات — يجب أن يحتوي كل تثبيت على شركة واحدة فقط. يرجى مراجعة الدعم الفني.",
    );
  }
}

/**
 * F06 (Phase 1 audit) + product decision: cashbox withdrawals and cash
 * payment vouchers must be hard-blocked when they would take the cashbox
 * balance negative, per-currency. Previously there was no server-side
 * balance-sufficiency check anywhere in the cash-out write paths (manual
 * movements, cash payment vouchers) — SYP reached -14,110 with no guard.
 */
export class InsufficientCashboxBalanceError extends DomainError {
  constructor(
    public readonly currency: string,
    public readonly available: number,
    public readonly requested: number,
  ) {
    super(
      "INSUFFICIENT_CASHBOX_BALANCE",
      `الرصيد غير كافٍ (${currency}): المتاح ${available}، المطلوب ${requested}. لا يمكن أن يصبح رصيد الصندوق سالباً.`,
    );
  }
}
