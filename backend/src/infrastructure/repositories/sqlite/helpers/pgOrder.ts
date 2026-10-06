/**
 * PostgreSQL ordering and LIKE semantics on SQLite (specs/001-desktop-sqlite-engine S4).
 *
 *   - NULL placement: PG sorts NULLs LAST in ASC and FIRST in DESC; SQLite does the opposite.
 *     These `asc`/`desc` replace Drizzle's in every SQLite twin and say it explicitly.
 *   - `like()`: PG LIKE is case-SENSITIVE; SQLite LIKE folds ASCII case. A PG LIKE pattern
 *     (backslash escapes, % and _) is translated to an equivalent case-sensitive GLOB.
 */
import { sql, type SQL, type SQLWrapper } from "drizzle-orm";

export const asc = (col: SQLWrapper): SQL => sql`${col} ASC NULLS LAST`;
export const desc = (col: SQLWrapper): SQL => sql`${col} DESC NULLS FIRST`;

/** PG LIKE pattern (default escape `\`) → SQLite GLOB pattern with the same matches. */
export function pgLikeToGlob(pattern: string): string {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "\\" && i + 1 < pattern.length) {
      out += globLiteral(pattern[++i]);
    } else if (ch === "%") out += "*";
    else if (ch === "_") out += "?";
    else out += globLiteral(ch);
  }
  return out;
}

function globLiteral(ch: string): string {
  return ch === "*" || ch === "?" || ch === "[" ? `[${ch}]` : ch;
}

/** PG `col LIKE pattern` (case-sensitive). */
export function likeCs(col: SQLWrapper, pattern: string): SQL {
  return sql`${col} GLOB ${pgLikeToGlob(pattern)}`;
}
