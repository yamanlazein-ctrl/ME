/**
 * Shared precision guard: the DB stores kg / prices in decimal(12,2), so any
 * value with more than 2 decimal places would be silently rounded on write and
 * create a mismatch between the journaled amount and the stored value (I4/I6).
 * Reject values with >2dp at the validation boundary instead of storing them.
 */
export function is2dp(v: number): boolean {
  return Math.abs(v * 100 - Math.round(v * 100)) < 1e-9;
}

export const MAX_2DP_MESSAGE = "القيمة تقبل حتى خانتين عشريتين كحد أقصى (دقة التخزين 0.01)";
