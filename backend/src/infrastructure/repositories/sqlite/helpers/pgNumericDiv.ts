/**
 * Exact PostgreSQL `numeric / numeric` (specs/001-desktop-sqlite-engine I-3).
 *
 * Repositories compute weighted averages in SQL (`SUM(q × p) / NULLIF(SUM(q), 0)`) and the code
 * then rounds `Number(result)`. To give bit-identical results the SQLite twins fetch both sums as
 * exact scaled integers and divide here with PG's own rules (src/backend/utils/adt/numeric.c):
 *   - result scale from `select_div_scale`: at least NUMERIC_MIN_SIG_DIGITS (16) significant digits,
 *     estimated from the base-10000 weights and first digits, never below either input's dscale;
 *   - the quotient rounded half away from zero to that scale (`div_var(…, round = true)`).
 */
import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

const NBASE_DIGITS = 4;
const MIN_SIG_DIGITS = 16;
const MAX_DISPLAY_SCALE = 1000;

/** Base-10000 weight and first (most significant) group of |value| = mag / 10^scale. */
function weightAndFirst(mag: bigint, scale: number): { weight: number; first: number } {
  if (mag === 0n) return { weight: 0, first: 0 };
  // Pad the fraction to a whole number of 4-digit groups so groups align at the decimal point.
  const padScale = Math.ceil(scale / NBASE_DIGITS) * NBASE_DIGITS;
  const aligned = mag * 10n ** BigInt(padScale - scale);
  const digits = aligned.toString();
  const fracGroups = padScale / NBASE_DIGITS;
  const totalGroups = Math.ceil(digits.length / NBASE_DIGITS);
  const padded = digits.padStart(totalGroups * NBASE_DIGITS, "0");
  for (let i = 0; i < totalGroups; i++) {
    const g = Number(padded.slice(i * NBASE_DIGITS, (i + 1) * NBASE_DIGITS));
    if (g !== 0) return { weight: totalGroups - fracGroups - 1 - i, first: g };
  }
  return { weight: 0, first: 0 };
}

/** PG numeric division of a/10^sa by b/10^sb (dscales da, db) → PG's text result, or null when b = 0. */
export function pgNumericDivide(a: bigint, sa: number, b: bigint, sb: number, da = sa, db = sb): string | null {
  if (b === 0n) return null; // callers wrap the divisor in NULLIF(…, 0)
  const neg = a < 0n !== b < 0n && a !== 0n;
  const ma = a < 0n ? -a : a;
  const mb = b < 0n ? -b : b;
  const w1 = weightAndFirst(ma, sa);
  const w2 = weightAndFirst(mb, sb);
  let qweight = w1.weight - w2.weight;
  if (w1.first <= w2.first) qweight--;
  let rscale = MIN_SIG_DIGITS - qweight * NBASE_DIGITS;
  rscale = Math.max(rscale, da, db, 0);
  rscale = Math.min(rscale, MAX_DISPLAY_SCALE);
  // q·10^rscale = ma·10^(sb + rscale) / (mb·10^sa), rounded half away from zero
  const num = ma * 10n ** BigInt(sb + rscale);
  const den = mb * 10n ** BigInt(sa);
  let r = num / den;
  if ((num % den) * 2n >= den) r += 1n;
  const s = r.toString().padStart(rscale + 1, "0");
  const body = rscale === 0 ? s : `${s.slice(0, -rscale)}.${s.slice(-rscale)}`;
  return neg && r !== 0n ? `-${body}` : body;
}

/**
 * SQL for `numerator / NULLIF(denominator, 0)` with PG numeric semantics: both scaled-integer sums
 * travel as one text value and are divided exactly in JS. Decodes to `Number(pgText)` (PG + node-pg
 * + `Number()`), or null where PG returns NULL.
 */
export function pgDivSql(
  numerator: SQL | SQLWrapper,
  numScale: number,
  denominator: SQL | SQLWrapper,
  denScale: number,
): SQL<number | null> {
  return sql`(CAST((${numerator}) AS TEXT) || '/' || CAST((${denominator}) AS TEXT))`.mapWith((v: unknown) => {
    if (v === null || v === undefined) return null;
    const [n, d] = String(v).split("/");
    const t = pgNumericDivide(BigInt(n), numScale, BigInt(d), denScale);
    return t === null ? null : Number(t);
  }) as SQL<number | null>;
}
