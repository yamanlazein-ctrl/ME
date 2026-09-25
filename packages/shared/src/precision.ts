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

/** Unit COST prices (roll price_per_kg) are stored with 4 decimals — see 20261017 migration. */
export function is4dp(v: number): boolean {
  return Math.abs(v * 10000 - Math.round(v * 10000)) < 1e-6;
}

export const MAX_4DP_MESSAGE = "سعر التكلفة يقبل حتى 4 خانات عشرية كحد أقصى";

export function round4dp(n: number): number {
  return Math.round((Number.isFinite(n) ? n : 0) * 10000) / 10000;
}

export const MAX_2DP_MESSAGE = "القيمة تقبل حتى خانتين عشريتين كحد أقصى (دقة التخزين 0.01)";

export const MAX_2DP_MSG = MAX_2DP_MESSAGE;

export function hasMoreThan2dp(n: number): boolean {
  return Number.isFinite(n) && n > 0 && Math.abs(n * 100 - Math.round(n * 100)) >= 1e-9;
}

export function round2dp(n: number): number {
  // Preserve the established project rounding behavior until an explicit
  // business decision approves a decimal-string/SQL-aligned replacement.
  return Math.round((Number.isFinite(n) ? n : 0) * 100) / 100;
}

/** Round money fields in a createInput for historical sync replay (REPAIR-009). */
export function normalizeMoney2dp<T extends Record<string, unknown>>(input: T): T {
  const moneyKeys = new Set([
    "discount",
    "tax",
    "shipping",
    "paid",
    "discountAmount",
    "amount",
    "creditApplied",
    "quantityKg",
    "pricePerKg",
    "openingBalance",
    "creditLimit",
  ]);
  const out: Record<string, unknown> = { ...input };
  for (const [k, v] of Object.entries(out)) {
    if (moneyKeys.has(k) && typeof v === "number") out[k] = round2dp(v);
    if (k === "lines" && Array.isArray(v)) {
      out[k] = v.map((line) =>
        line && typeof line === "object"
          ? normalizeMoney2dp(line as Record<string, unknown>)
          : line,
      );
    }
  }
  return out as T;
}
