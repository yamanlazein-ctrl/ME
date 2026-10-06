/**
 * Raw-row values exactly as PostgreSQL's `db.execute()` returns them through Drizzle node-postgres
 * (specs/001-desktop-sqlite-engine I-3): timestamptz/date as PG text (session TimeZone = UTC on the
 * desktop cluster), numeric as text with its scale, int4 as numbers. SQLite twins of raw-SQL
 * helpers convert their rows with these so callers and API responses see identical values.
 */
import { scaledText } from "./likeContains.js";

/** "2026-10-03T12:34:56.123400Z" → "2026-10-03 12:34:56.1234+00" (PG trims trailing fraction zeros). */
export function pgTimestamptzText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  const m = /^(\d{4}-\d{2}-\d{2})T(\d{2}:\d{2}:\d{2})(?:\.(\d+))?Z$/.exec(s);
  if (!m) return s;
  const frac = (m[3] ?? "").replace(/0+$/, "");
  return `${m[1]} ${m[2]}${frac ? `.${frac}` : ""}+00`;
}

/** Map named row fields: money scaled integers → PG numeric text; timestamps → PG text. */
export function pgRawRows<R extends Record<string, unknown>>(
  rows: R[],
  spec: { money?: Record<string, number>; timestamps?: string[] },
): R[] {
  return rows.map((r) => {
    const o: Record<string, unknown> = { ...r };
    for (const [k, scale] of Object.entries(spec.money ?? {})) if (k in o && o[k] !== null) o[k] = scaledText(o[k], scale);
    for (const k of spec.timestamps ?? []) if (k in o) o[k] = pgTimestamptzText(o[k]);
    return o as R;
  });
}
