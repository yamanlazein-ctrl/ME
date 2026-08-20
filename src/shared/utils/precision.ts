/**
 * Numeric precision helpers used by the invoice forms.
 *
 * The backend stores decimals as `decimal(12,2)` and rejects any quantity or
 * price with more than 2 decimal places (see backend/src/presentation/routes
 * /precision.ts — `is2dp` / `MAX_2DP_MESSAGE`). Mirroring that rule on the
 * client gives the user a field-specific message BEFORE the request is sent,
 * instead of a generic "البيانات المدخلة غير صحيحة".
 */

/** Same wording as the backend so the message is consistent. */
export const MAX_2DP_MSG = "القيمة تقبل حتى خانتين عشريتين كحد أقصى (دقة التخزين 0.01)";

/** `true` iff `n` is a positive number with more than 2 decimal places. */
export function hasMoreThan2dp(n: number): boolean {
  return Number.isFinite(n) && n > 0 && Math.abs(n * 100 - Math.round(n * 100)) >= 1e-9;
}

/** Round a value to 2 decimal places (used when the user leaves it >=3dp). */
export function round2dp(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
}
