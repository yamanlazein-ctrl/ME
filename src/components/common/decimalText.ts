/**
 * Typed-number normalisation shared by every amount / quantity field.
 *
 * Accepts what people actually type here: thousands commas ("32,900.32"), Arabic-Indic and
 * Persian digits (٣٢٩٠٠), the Arabic decimal sign (٫) and thousands sign (٬), spaces.
 * Comma is always a thousands separator; the decimal point is "." or "٫".
 */
const EASTERN_DIGITS = /[٠-٩۰-۹]/g;

export function normalizeDecimalText(raw: string): string {
  return raw
    .replace(EASTERN_DIGITS, (d) => String(d.charCodeAt(0) & 0xf))
    .replace(/٫/g, ".")
    .replace(/[,٬\s]/g, "");
}

/**
 * True for a complete or still-being-typed number: "", "12", "12.", ".5", "-" (when allowed), with
 * at most `maxDecimals` digits after the point (money and kg: 2 — the server's precision rule).
 */
export function isPartialDecimal(s: string, allowNegative = false, maxDecimals = 2): boolean {
  const sign = allowNegative ? "-?" : "";
  return new RegExp(`^${sign}[0-9]*([.][0-9]{0,${maxDecimals}})?$`).test(s);
}

/** "32900.32" → "32,900.32". Groups the integer part only; never rounds the decimals. */
export function groupThousands(s: string): string {
  const [intPart, frac] = s.split(".");
  const neg = intPart.startsWith("-");
  const digits = (neg ? intPart.slice(1) : intPart).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return `${neg ? "-" : ""}${digits}${frac !== undefined ? `.${frac}` : ""}`;
}
