/**
 * Bug #5 — the print-receive decimal fields.
 *
 * The three fields (الكمية المستلمة / تكلفة الطباعة / سعر البيع) must accept a
 * decimal that the operator is still typing. `input[type=number]` reports its
 * value as a string, so a keystroke-by-keystroke parse with `Number()` throws
 * away a trailing separator: typing "10." yields `Number("10.") === 10`, and
 * the operator can no longer type "10.5" because the field silently rounds
 * back to "10".
 *
 * The rule is therefore two parts, and both live here so they are provable
 * without a browser:
 *
 *   1. `acceptsDecimalKeystroke` — is this a value we should accept as typed?
 *   2. `parseDecimalField`     — the committed numeric value, or null while the
 *                                field is still incomplete (e.g. "10.").
 *
 * The fields keep their raw STRING in component state (so the caret and the
 * text survive) and are converted to a number once, at submit.
 */

/** A non-negative decimal, possibly mid-typing: "10", "10.", ".5", "19.75". */
const DECIMAL_KEYSTROKE = /^\d*\.?\d*$/;

/**
 * True when the raw field text is a decimal we should keep verbatim.
 *
 * Rejects: a sign, an exponent, a second separator, embedded spaces, and
 * anything non-numeric. The fields are physical weights and prices, so a
 * negative value is not a meaningful input here and is filtered at the edge.
 */
export function acceptsDecimalKeystroke(raw: string): boolean {
  return DECIMAL_KEYSTROKE.test(raw);
}

export function parseDecimalField(raw: string): number | null {
  if (!acceptsDecimalKeystroke(raw)) return null;
  if (raw === "" || raw === ".") return null;
  // A trailing separator means the operator is mid-keystroke. `Number("10.")`
  // is 10, so parsing it here is exactly the bug: it would let the field fall
  // back to "10" and make "10.5" untypeable.
  if (raw.endsWith(".")) return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}
