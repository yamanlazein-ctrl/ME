import { ValidationError } from "@/domain/errors";

export function required<T>(value: T | null | undefined, field?: string): NonNullable<T> {
  if (value === null || value === undefined || value === "") {
    throw new ValidationError(`${field ?? "Value"} is required.`, field);
  }
  return value as NonNullable<T>;
}

export function positiveNumber(value: unknown, field?: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) {
    throw new ValidationError(`${field ?? "Value"} must be a positive number.`, field);
  }
  return n;
}

export function nonNegative(value: unknown, field?: string): number {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) {
    throw new ValidationError(`${field ?? "Value"} must be a non-negative number.`, field);
  }
  return n;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function isUUID(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

export function isEmail(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}
