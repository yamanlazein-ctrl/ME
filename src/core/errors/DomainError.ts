export class DomainError extends Error {
  /** Set by interceptors to signal a retry after resolving the cause (e.g. token refresh). */
  retryable?: boolean;

  constructor(
    public readonly code: string,
    message: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = "DomainError";
  }
}

export class ValidationError extends DomainError {
  constructor(
    message: string,
    /** Field-level validation messages keyed by dotted path (e.g. "lines.0.pricePerKg"). */
    public readonly details?: Record<string, string[]>,
  ) {
    super("VALIDATION", message, 422);
    this.name = "ValidationError";
  }
}

export class NotFoundError extends DomainError {
  constructor(message: string) {
    super("NOT_FOUND", message, 404);
    this.name = "NotFoundError";
  }
}

export class NetworkError extends DomainError {
  constructor(
    message: string,
    public readonly cause?: Error,
  ) {
    super("NETWORK", message, 0);
    this.name = "NetworkError";
  }
}

export class UnauthorizedError extends DomainError {
  constructor(message = "طلب تسجيل دخول") {
    super("UNAUTHORIZED", message, 401);
    this.name = "UnauthorizedError";
  }
}

export class ForbiddenError extends DomainError {
  constructor(message = "لا تملك صلاحية") {
    super("FORBIDDEN", message, 403);
    this.name = "ForbiddenError";
  }
}

export class ConflictError extends DomainError {
  constructor(message: string) {
    super("CONFLICT", message, 409);
    this.name = "ConflictError";
  }
}

export class ApiError extends DomainError {
  constructor(
    statusCode: number,
    message: string,
    public readonly responseBody?: unknown,
  ) {
    super("API_ERROR", message, statusCode);
    this.name = "ApiError";
  }
}

export class NotImplementedError extends DomainError {
  constructor(message: string) {
    super("NOT_IMPLEMENTED", message, 501);
    this.name = "NotImplementedError";
  }
}

export function mapHttpStatusToDomainError(
  status: number,
  body: unknown,
  message?: string,
): DomainError {
  switch (status) {
    case 401:
      return new UnauthorizedError(message);
    case 403:
      return new ForbiddenError(message);
    case 404:
      return new NotFoundError(message ?? "الموارد غير موجودة");
    case 409:
      return new ConflictError(message ?? "تعارض في البيانات");
    case 422: {
      const b = (body ?? {}) as { details?: Record<string, string[]> };
      return new ValidationError(message ?? "بيانات غير صالحة", b.details);
    }
    default:
      return new ApiError(status, message ?? `خطأ في الخادم (${status})`, body);
  }
}
