/**
 * Single source of truth for numeric precision — replaces
 * backend/src/presentation/routes/precision.ts and src/shared/utils/precision.ts
 * and the dead src/core/precision.ts (MONEY_DECIMALS=0).
 *
 * DB stores kg/prices as decimal(12,2) and bigint whole units for money.
 * Validation: reject >2dp at the boundary. Display: round once at edge.
 * See docs/money-representation.md
 */

export function is2dp(v: number): boolean {
  return Math.abs(v * 100 - Math.round(v * 100)) < 1e-9;
}

export const MAX_2DP_MESSAGE = "القيمة تقبل حتى خانتين عشريتين كحد أقصى (دقة التخزين 0.01)";

export const MAX_2DP_MSG = MAX_2DP_MESSAGE;

export function hasMoreThan2dp(n: number): boolean {
  return Number.isFinite(n) && n > 0 && Math.abs(n * 100 - Math.round(n * 100)) >= 1e-9;
}

export function round2dp(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
}
