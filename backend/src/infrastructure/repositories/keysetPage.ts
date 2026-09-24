import { desc, sql, type AnyColumn, type SQL } from "drizzle-orm";

/**
 * Keyset ("seek") paging for "load every row" callers.
 *
 * OFFSET makes page N scan and discard every earlier row, so fetching a full
 * history is quadratic (100 pages of invoices at 100k took ~15 s, the deepest
 * page 5x the first). A cursor names the last row seen; the next page starts
 * right after it through the index — every page costs the same.
 *
 * Order is always DESC on (date?, created_at, id): `id` makes it a strict
 * total order, so rows sharing a timestamp are never repeated or skipped.
 * created_at travels with MICROSECONDS (a JS Date keeps milliseconds only —
 * the same truncation duplicated statement rows before it was fixed).
 */
export type KeysetSpec = { date?: AnyColumn; createdAt: AnyColumn; id: AnyColumn };
type Cursor = { d?: string; c: string; i: string };

export function decodeCursor(raw: string | null | undefined): Cursor | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(Buffer.from(raw, "base64url").toString("utf8")) as Cursor;
    if (typeof v.c !== "string" || typeof v.i !== "string") return null;
    if (!/^[0-9a-f-]{36}$/i.test(v.i)) return null;
    return v;
  } catch {
    return null;
  }
}

function encodeCursor(v: Cursor): string {
  return Buffer.from(JSON.stringify(v), "utf8").toString("base64url");
}

/**
 * Extra select columns for the cursor: created_at with microseconds (UTC ISO)
 * and the business date as TEXT (never through a JS Date — no timezone shift).
 */
export function cursorColumns(spec: KeysetSpec) {
  return {
    __kc: sql<string>`to_char(${spec.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
    ...(spec.date ? { __kd: sql<string>`${spec.date}::text` } : {}),
  };
}

/** Rows strictly after the cursor in DESC (date, created_at, id) order. */
export function afterCursor(spec: KeysetSpec, cursor: Cursor): SQL {
  if (spec.date && cursor.d) {
    return sql`(${spec.date}, ${spec.createdAt}, ${spec.id}) < (${cursor.d}::date, ${cursor.c}::timestamptz, ${cursor.i}::uuid)`;
  }
  return sql`(${spec.createdAt}, ${spec.id}) < (${cursor.c}::timestamptz, ${cursor.i}::uuid)`;
}

export function keysetOrder(spec: KeysetSpec) {
  return spec.date
    ? [desc(spec.date), desc(spec.createdAt), desc(spec.id)]
    : [desc(spec.createdAt), desc(spec.id)];
}

/** Cursor of the last row of a full page; null when this was the last page. */
export function nextCursorOf(rows: Array<Record<string, unknown>>, limit: number): string | null {
  if (rows.length < limit || rows.length === 0) return null;
  const last = rows[rows.length - 1]!;
  return encodeCursor({
    d: typeof last.__kd === "string" ? last.__kd : undefined,
    c: String(last.__kc),
    i: String(last.id),
  });
}
