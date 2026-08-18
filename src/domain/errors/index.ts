import { type Result, Ok, Err, isOk } from "@/core/result";
import {
  DomainError,
  ValidationError as CoreValidationError,
  NotFoundError as CoreNotFoundError,
  ConflictError as CoreConflictError,
} from "@/core/errors/DomainError";

/* ── Domain errors ─────────────────────────────────────────────────── */

export class BusinessLogicError extends DomainError {
  constructor(code: string, message: string) {
    super(code, message);
  }
}

export class ValidationError extends CoreValidationError {
  public readonly field?: string;
  constructor(message: string, field?: string) {
    super(message);
    this.field = field;
  }
}

export class NotFoundError extends CoreNotFoundError {
  constructor(entity: string, id?: string) {
    super(`${entity}${id ? ` (${id})` : ""} not found.`);
  }
}

export class AuthorizationError extends DomainError {
  constructor(message = "Unauthorized.") {
    super("UNAUTHORIZED", message);
  }
}

export class ConflictError extends CoreConflictError {
  constructor(message: string) {
    super(message);
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
      `Roll ${rollId}: requested ${requested}, only ${available} available.`,
    );
  }
}

export class ConcurrentModificationError extends DomainError {
  constructor(entity: string, id: string) {
    super(
      "CONCURRENT_MODIFICATION",
      `${entity} ${id} was modified by another request. Please retry.`,
    );
  }
}

/* ── Type helpers for Result-based returns ─────────────────────────── */

export type ResultOr<T, E extends DomainError> = Result<T, E>;

export { type Result, Ok, Err, isOk };
