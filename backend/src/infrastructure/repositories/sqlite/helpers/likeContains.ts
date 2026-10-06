/**
 * SQLite equivalents of the PostgreSQL SQL idioms used by the repositories
 * (specs/001-desktop-sqlite-engine T052, research R7/I-3).
 *
 *   - ILIKE → `LIKE … ESCAPE '\'`. SQLite's LIKE folds ASCII case only, which is exactly PG
 *     ILIKE under the C locale the desktop cluster uses; Arabic has no case. The pattern comes
 *     from the shared `likeContains()`, which escapes with backslash — PG's default ILIKE escape,
 *     declared explicitly here because SQLite LIKE has no default escape character.
 *   - Money aggregates: columns hold scaled integers, so a SUM is an exact integer of the same
 *     scale; `.mapWith(column)` decodes it through the column type, giving `Number(pgText)` like PG.
 *   - Mixed-scale arithmetic (qty(14,2) × price(14,4) = scale 6) is summed as an exact integer and
 *     decoded with `scaledText`, so the result equals PG's exact numeric rendered and Number()'d.
 */
import { sql, type SQL, type SQLWrapper, type Column } from "drizzle-orm";
import { likeContains } from "../../../utils/likeEscape.js";
import { formatScaled, toScaledInteger } from "../../../orm/sqlite/types.js";

/** `col ILIKE '%term%'` (PG) → `col LIKE '%term%' ESCAPE '\'` (SQLite, same result set). */
export function ilikeContains(col: SQLWrapper, term: string): SQL {
  return sql`${col} LIKE ${likeContains(term)} ESCAPE '\\'`;
}

/** `col ILIKE pattern` for an already-escaped pattern (backslash escapes). */
export function ilikeEscaped(col: SQLWrapper, pattern: string): SQL {
  return sql`${col} LIKE ${pattern} ESCAPE '\\'`;
}

/** `coalesce(sum(col), 0)` decoded through the column type (exact; `number` or PG text per mode). */
export function sumMoney<T = number>(col: Column): SQL<T> {
  return sql`coalesce(sum(${col}), 0)`.mapWith(col) as SQL<T>;
}

/** An exact scaled-integer expression (scale `scale`) → the number PG's numeric would give. */
export function scaledNumber(expr: SQL | SQLWrapper, scale: number): SQL<number> {
  return sql`${expr}`.mapWith((v: unknown) => Number(scaledText(v, scale))) as SQL<number>;
}

/** Decode a raw scaled integer (number | bigint | string | null) to PG numeric text. */
export function scaledText(v: unknown, scale: number): string {
  if (v === null || v === undefined) return formatScaled(0n, scale);
  if (typeof v === "bigint") return formatScaled(v, scale);
  if (typeof v === "number") return formatScaled(BigInt(Math.trunc(v)), scale);
  return formatScaled(BigInt(String(v)), scale);
}

/** An exact scaled-integer expression rendered as PG numeric text at `scale` (`::text` of a sum). */
export function scaledTextSql(expr: SQL | SQLWrapper, scale: number): SQL<string> {
  return sql`${expr}`.mapWith((v: unknown) => scaledText(v, scale)) as SQL<string>;
}

/**
 * Integer division rounding half away from zero — PG numeric `round()` on a scaled integer.
 * (SQLite's `round()` works in floating point and must never touch money.)
 */
export function roundDiv(expr: SQL | SQLWrapper, divisor: number): SQL {
  if (divisor === 1) return sql`(${expr})`;
  const half = Math.floor(divisor / 2);
  return sql`(CASE WHEN (${expr}) >= 0 THEN ((${expr}) + ${sql.raw(String(half))}) / ${sql.raw(String(divisor))} ELSE -((-(${expr}) + ${sql.raw(String(half))}) / ${sql.raw(String(divisor))}) END)`;
}

/** `ROUND(a × b, target)` for scaled columns a (scale sa) and b (scale sb) → scaled at `target`. */
export function mulRound(a: SQL | SQLWrapper, sa: number, b: SQL | SQLWrapper, sb: number, target: number): SQL {
  return roundDiv(sql`(${a}) * (${b})`, 10 ** (sa + sb - target));
}

/** Rescale an exact scaled expression from scale `from` up to scale `to` (no rounding needed). */
export function upscale(expr: SQL | SQLWrapper, from: number, to: number): SQL {
  if (to < from) throw new Error("upscale only widens; use roundDiv to narrow");
  return to === from ? sql`(${expr})` : sql`((${expr}) * ${sql.raw(String(10 ** (to - from)))})`;
}

/** A scaled-integer column rendered in SQL exactly as PG prints numeric(p,s) (`col::text`, e.g. "-0.50"). */
export function numericTextSql(col: SQL | SQLWrapper, scale: number): SQL<string> {
  const f = sql.raw(String(10 ** scale));
  return sql<string>`(CASE WHEN (${col}) IS NULL THEN NULL ELSE
    (CASE WHEN (${col}) < 0 THEN '-' ELSE '' END) || (abs(${col}) / ${f}) || '.' || substr('${sql.raw("0".repeat(scale))}' || (abs(${col}) % ${f}), -${sql.raw(String(scale))}) END)`;
}

/**
 * A JS money value bound for SQL arithmetic against a scaled column of scale `scale`
 * (`col + value` on PG adds an exact decimal; here both sides are scaled integers).
 */
export function moneyParam(value: number | string, scale: number): SQL {
  const n = toScaledInteger(value, 18, scale);
  return sql`${n >= BigInt(Number.MIN_SAFE_INTEGER) && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : n}`;
}

/** PG `GREATEST(a, b)`: NULL arguments are ignored (SQLite's max() would return NULL). */
export function greatest(a: SQL | SQLWrapper, b: SQL | SQLWrapper): SQL {
  return sql`COALESCE(max(${a}, ${b}), ${a}, ${b})`;
}

/** PG `LEAST(a, b)`: NULL arguments are ignored. */
export function least(a: SQL | SQLWrapper, b: SQL | SQLWrapper): SQL {
  return sql`COALESCE(min(${a}, ${b}), ${a}, ${b})`;
}

/** Scaled integer → decimal text (input to motard_decsum; see orm/sqlite/numericFunctions.ts). */
export function decText(expr: SQL | SQLWrapper, scale: number): SQL {
  return sql`motard_dectext(${expr}, ${sql.raw(String(scale))})`;
}

/** PG `a / b` on scaled integers → PG's exact quotient text (NULL when b is 0/NULL). */
export function pgDivText(a: SQL | SQLWrapper, sa: number, b: SQL | SQLWrapper, sb: number): SQL {
  return sql`motard_pgdiv(${a}, ${sql.raw(String(sa))}, ${b}, ${sql.raw(String(sb))})`;
}

/** Exact `COALESCE(SUM(textExpr), 0)` over decimal texts, decoded as Number(pgText). */
export function decSumNumber(textExpr: SQL | SQLWrapper): SQL<number> {
  return sql`COALESCE(motard_decsum(${textExpr}), '0')`.mapWith((v: unknown) => Number(v)) as SQL<number>;
}

/** Scale factor of a numeric(p,s) column as an SQL literal (10^s). */
export const SCALE = { 2: 100, 3: 1000, 4: 10000, 6: 1000000 } as const;
