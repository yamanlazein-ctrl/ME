/**
 * Safe colour helpers.
 *
 * Purpose: guarantee that a user-supplied or DB-stored colour string can
 * NEVER crash the UI, even when it is malformed (e.g. a random text like
 * "jkjlj", a bare number, `null`, `undefined`, or a non-hex value).
 *
 * Every place that applies a colour to a CSS `background`/`color` or feeds
 * an `<input type="color">` value should go through these — never use a raw
 * stored string directly. All transformations are wrapped in try/catch so an
 * unexpected value type degrades to a safe fallback instead of throwing.
 */

/** Neutral, non-misleading fallback (gray-300) — same as the ColourSwatch default. */
export const COLOR_NEUTRAL_FALLBACK = "#d1d5db";

/** Black fallback used by native colour pickers (`<input type="color">`). */
export const COLOR_PICKER_FALLBACK = "#000000";

const HEX_RE = /^#?([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/**
 * Returns `true` only for a syntactically valid hex colour (3/4/6/8 digits,
 * with or without a leading `#`). Never throws.
 */
export function isValidHexColor(value: unknown): value is string {
  if (typeof value !== "string") return false;
  return HEX_RE.test(value.trim());
}

/**
 * Normalize an arbitrary value into a CSS-ready hex string.
 *
 * - `null`/`undefined`/non-string → `fallback`
 * - valid hex (3/4/6/8 digit, `#` optional) → normalized with a leading `#`
 * - anything else (malformed text, numbers, objects) → `fallback`
 *
 * Wrapped in try/catch so it can never throw.
 */
export function safeHexColor(value: unknown, fallback: string = COLOR_NEUTRAL_FALLBACK): string {
  try {
    if (typeof value !== "string") return fallback;
    const trimmed = value.trim();
    if (!isValidHexColor(trimmed)) return fallback;
    const hex = trimmed.startsWith("#") ? trimmed : `#${trimmed}`;
    // Lowercase for consistency; browsers accept either.
    return hex.toLowerCase();
  } catch {
    return fallback;
  }
}

/**
 * Converts a normalized hex colour to an `rgb()` string. Returns the fallback
 * when the input is not a valid 6-digit hex, so callers can degrade safely.
 */
export function hexToRgbSafe(value: unknown, fallback: string = "rgb(209 213 219)"): string {
  try {
    const hex = safeHexColor(value);
    if (hex.length !== 7) return fallback;
    const r = parseInt(hex.slice(1, 3), 16);
    const g = parseInt(hex.slice(3, 5), 16);
    const b = parseInt(hex.slice(5, 7), 16);
    if ([r, g, b].some((n) => Number.isNaN(n))) return fallback;
    return `rgb(${r} ${g} ${b})`;
  } catch {
    return fallback;
  }
}
