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

export class RateLimitExceededError extends DomainError {
  constructor() {
    super("RATE_LIMIT_EXCEEDED", "تم تجاوز الحد المسموح من الطلبات. يرجى المحاولة لاحقاً");
  }
}
