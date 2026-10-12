/**
 * Single source of truth for numeric precision — replaces
 * backend/src/presentation/routes/precision.ts and src/shared/utils/precision.ts
 * and the dead src/core/precision.ts (MONEY_DECIMALS=0).
 *
 * DB stores kg/prices as decimal(12,2) and bigint whole units for money.
 * Validation: reject >2dp at the boundary. Display: round once at edge.
 * See docs/money-representation.md
 */

/**
 * `x` (= v × 10^k) is a whole number up to binary float error. That error grows with |x| (≈ |x|·ε), so a
 * fixed tolerance rejected valid large amounts (M-03: 10,000,000.29 × 100 is off by 1.2e-7).
 */
function nearInteger(x: number, floor: number): boolean {
  return Math.abs(x - Math.round(x)) < Math.max(floor, 4 * Number.EPSILON * Math.abs(x));
}

export function is2dp(v: number): boolean {
  return nearInteger(v * 100, 1e-9);
}

/** Unit COST prices (roll price_per_kg) are stored with 4 decimals — see 20261017 migration. */
export function is4dp(v: number): boolean {
  return nearInteger(v * 10000, 1e-6);
}

export const MAX_4DP_MESSAGE = "سعر التكلفة يقبل حتى 4 خانات عشرية كحد أقصى";

/**
 * THE rounding policy (F-008): exact DECIMAL rounding, half away from zero — the same result as
 * PostgreSQL `ROUND(numeric, k)` and the SQLite engine's scaled-integer `roundDiv`/`pgNumericDivide`,
 * so a figure posted by JS and re-computed in SQL is always the same number.
 *
 * `Math.round(n × 10^k)` rounded the binary float, not the decimal: 0.18 × 1.25 is stored as
 * 0.22499999999999998, so 0.225 became 0.22 (a correct accountant gets 0.23), and `Math.round(−2.5)`
 * is −2 (half toward +∞). Here the value is first read as its 15-significant-digit decimal — the
 * number the inputs actually denote; money columns hold ≤ 12 integer digits (numeric(14,2)), so 15
 * digits always reach the deciding decimal — and rounded on that string.
 */
function roundDecimal(n: number, places: number): number {
  if (!Number.isFinite(n)) return 0;
  const text = n.toPrecision(15);
  if (/e/i.test(text)) {
    // |n| < 1e-6 (rounds to 0 at these scales) or ≥ 1e15 (beyond any stored money / float cents).
    const f = 10 ** places;
    return Math.round(n * f) / f;
  }
  const negative = text.startsWith("-");
  const [whole, fraction = ""] = (negative ? text.slice(1) : text).split(".");
  const digits = (fraction + "0".repeat(places + 1)).slice(0, places + 1);
  let units = BigInt(whole + digits.slice(0, places));
  if (digits.charCodeAt(places) >= 53 /* "5" */) units += 1n; // half away from zero
  const value = Number(units) / 10 ** places;
  return negative && value !== 0 ? -value : value; // never −0
}

export function round4dp(n: number): number {
  return roundDecimal(n, 4);
}

export const MAX_2DP_MESSAGE = "القيمة تقبل حتى خانتين عشريتين كحد أقصى (دقة التخزين 0.01)";

export const MAX_2DP_MSG = MAX_2DP_MESSAGE;

export function hasMoreThan2dp(n: number): boolean {
  return Number.isFinite(n) && n > 0 && !is2dp(n);
}

export function round2dp(n: number): number {
  return roundDecimal(n, 2);
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
