// Display formatting for amounts. The UI only displays: totals come from the use-cases (constitution I). The
// only arithmetic here is `round2dp` from @erp/shared to show two decimals.
import { hasMoreThan2dp, round2dp } from "@erp/shared";

const MINUS = "−";

export function groupThousands(integerPart: string): string {
  return integerPart.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

/** 1250.5 → "1,250.50"; negative numbers keep a leading minus sign (U+2212). */
export function formatAmount(amount: number): string {
  const value = round2dp(amount);
  const negative = value < 0;
  const [integer = "0", fraction = "00"] = Math.abs(value).toFixed(2).split(".");
  return `${negative ? MINUS : ""}${groupThousands(integer)}.${fraction}`;
}

/** Text typed in a money field → the number it denotes, or null when empty/invalid. */
export function parseTypedAmount(text: string): number | null {
  const cleaned = text.replace(/,/g, "").trim();
  if (cleaned === "" || cleaned === ".") return null;
  if (!/^\d*\.?\d*$/.test(cleaned)) return null;
  const value = Number(cleaned);
  return Number.isFinite(value) ? value : null;
}

/**
 * Applies one edit to a money field: digits and one dot only, thousands separators while typing, and never more than
 * 2 decimals (`hasMoreThan2dp`, UX-08). Returns the text to show, or null when the edit must be refused.
 */
export function normalizeTyping(text: string): string | null {
  const stripped = text.replace(/,/g, "");
  if (stripped === "") return "";
  if (!/^\d*\.?\d*$/.test(stripped)) return null;
  const value = parseTypedAmount(stripped);
  if (value !== null && hasMoreThan2dp(value)) return null;
  const [integer = "", fraction] = stripped.split(".");
  const grouped = groupThousands(integer.replace(/^0+(?=\d)/, ""));
  return fraction === undefined ? grouped : `${grouped === "" ? "0" : grouped}.${fraction}`;
}
