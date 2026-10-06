/**
 * Exact PostgreSQL numeric arithmetic inside SQLite queries (specs/001-desktop-sqlite-engine I-3).
 *
 * Money is stored as scaled integers, which covers +, −, × and SUM exactly in plain SQL. Division
 * is different: PG's `numeric / numeric` picks a result scale (≥ 16 significant digits) and rounds,
 * and queries SUM such quotients. These app functions reproduce that exactly, so a query keeps
 * its SQL shape:
 *   motard_pgdiv(a, sa, b, sb)  → PG text of (a/10^sa) / (b/10^sb), NULL when b = 0 or NULL
 *   motard_dectext(n, s)        → scaled integer n at scale s as decimal text
 *   motard_decsum(text)         → exact decimal SUM (aggregate), NULL over no non-NULL rows
 *   motard_re_substr(text, pattern, flags) → PG `substring(text from re)`: first capture group, else whole match
 *   motard_re_match(text, pattern, flags)  → PG `text ~ re` / `~*` (1/0, NULL for NULL text)
 * They are used in queries only (never in schema objects), so trusted_schema=OFF does not block them.
 */
import type Database from "better-sqlite3";
import { pgNumericDivide } from "../../repositories/sqlite/helpers/pgNumericDiv.js";
import { formatScaled } from "./types.js";

function toBig(v: unknown): bigint | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "bigint") return v;
  if (typeof v === "number") return BigInt(Math.trunc(v));
  return BigInt(String(v));
}

/** Parse a decimal text into (scaled integer, scale). */
export function parseDecimal(text: string): { v: bigint; s: number } {
  const neg = text.startsWith("-");
  const t = neg ? text.slice(1) : text;
  const [i, f = ""] = t.split(".");
  const v = BigInt((i || "0") + f);
  return { v: neg ? -v : v, s: f.length };
}

const reCache = new Map<string, RegExp>();
function re(pattern: unknown, flags: unknown): RegExp {
  const key = `${String(flags)}/${String(pattern)}`;
  let r = reCache.get(key);
  if (!r) {
    r = new RegExp(String(pattern), String(flags ?? ""));
    reCache.set(key, r);
  }
  return r;
}

export function registerNumericFunctions(db: Database.Database): void {
  db.function("motard_re_substr", { deterministic: true }, (text: unknown, pattern: unknown, flags: unknown) => {
    if (text === null || text === undefined) return null;
    const m = re(pattern, flags).exec(String(text));
    if (!m) return null;
    return m.length > 1 ? (m[1] ?? null) : m[0];
  });
  db.function("motard_re_match", { deterministic: true }, (text: unknown, pattern: unknown, flags: unknown) => {
    if (text === null || text === undefined) return null;
    return re(pattern, flags).test(String(text)) ? 1 : 0;
  });
  db.function("motard_pgdiv", { deterministic: true, safeIntegers: true }, (a: unknown, sa: unknown, b: unknown, sb: unknown) => {
    const x = toBig(a);
    const y = toBig(b);
    if (x === null || y === null || y === 0n) return null;
    return pgNumericDivide(x, Number(sa), y, Number(sb));
  });
  db.function("motard_dectext", { deterministic: true, safeIntegers: true }, (n: unknown, s: unknown) => {
    const x = toBig(n);
    return x === null ? null : formatScaled(x, Number(s));
  });
  db.aggregate("motard_decsum", {
    start: () => null as { v: bigint; s: number } | null,
    step: (acc: { v: bigint; s: number } | null, text: unknown) => {
      if (text === null || text === undefined) return acc;
      const d = parseDecimal(String(text));
      if (!acc) return d;
      const s = Math.max(acc.s, d.s);
      return { v: acc.v * 10n ** BigInt(s - acc.s) + d.v * 10n ** BigInt(s - d.s), s };
    },
    result: (acc: { v: bigint; s: number } | null) => (acc ? formatScaled(acc.v, acc.s) : null),
  });
}
