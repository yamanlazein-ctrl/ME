/**
 * RTL-safe number formatter with thousands separators.
 * All numeric displays in the project should use this utility to ensure
 * consistent formatting and correct rendering in RTL Arabic layout.
 *
 * Features:
 * - Thousands separator: 15,000, 1,500,000
 * - Preserves decimals: 1.5, 2.35
 * - No bidi-flip: numbers stay LTR even in RTL context
 * - Negative numbers: -15,000
 * - Zero: 0
 *
 * For use in JSX, wrap the output in a span with dir="ltr":
 *   <span dir="ltr">{formatNumber(15000)}</span>
 *
 * For numbers that should be rounded before formatting (money amounts),
 * call Math.round first: formatNumber(Math.round(n))
 */
export function formatNumber(n: number | string | null | undefined): string {
  if (n === null || n === undefined) return "—";
  const num = typeof n === "string" ? Number(n) : n;
  if (Number.isNaN(num)) return "—";
  // Use en-US locale for consistent comma separator regardless of runtime
  return num.toLocaleString("en-US", { maximumFractionDigits: 2 });
}

/**
 * Money amount formatter: rounds to integer then formats with separators.
 * Use this for all monetary amounts (SYP, USD, EUR).
 */
export function formatMoney(n: number | string | null | undefined): string {
  if (n === null || n === undefined) return "—";
  const num = typeof n === "string" ? Number(n) : n;
  if (Number.isNaN(num)) return "—";
  return Math.round(num).toLocaleString("en-US");
}

/**
 * Quantity formatter: preserves up to 2 decimals (1.5 kg, 0.25 kg).
 * Use this for quantities, weights, stock amounts.
 */
export function formatQuantity(n: number | string | null | undefined): string {
  if (n === null || n === undefined) return "—";
  const num = typeof n === "string" ? Number(n) : n;
  if (Number.isNaN(num)) return "—";
  // Show as-is if it has decimals, otherwise integer format
  if (Number.isInteger(num)) return num.toLocaleString("en-US");
  return num.toLocaleString("en-US", { minimumFractionDigits: 1, maximumFractionDigits: 2 });
}
