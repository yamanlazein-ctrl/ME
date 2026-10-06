/**
 * REPAIR-001 — page through list APIs until the end (never treat one page as "all").
 *
 * Accepts the three shapes our list adapters return: a bare array, the raw
 * API envelope `{ data, meta: { hasNext, nextCursor } }`, and the repository
 * result `{ data, hasNext, nextCursor }`.
 *
 * Keyset first: when a page returns `nextCursor`, the next request passes it
 * back and the server seeks right after the last row seen (constant cost per
 * page, and rows inserted meanwhile can't shift or duplicate the walk). Pages
 * without a cursor fall back to 0-based page numbers (`page * limit` OFFSET).
 */
export type PageMeta = {
  hasNext?: boolean;
  totalPages?: number;
  page?: number;
  limit?: number;
  nextCursor?: string | null;
};

type PageResult<T> =
  | { data: T[]; meta?: PageMeta; hasNext?: boolean; nextCursor?: string | null }
  | T[];

export async function fetchAllPaged<T>(
  fetchPage: (page: number, limit: number, cursor?: string) => Promise<PageResult<T>>,
  opts?: { pageSize?: number; label?: string },
): Promise<T[]> {
  const pageSize = opts?.pageSize ?? 200;
  const out: T[] = [];
  let cursor: string | undefined;
  // Track P (C-11 / FR-022): no page cap. Walk until the server reports the
  // end. A keyset cursor that repeats would loop forever: that is a server
  // defect, so fail loudly — never return a silently truncated list (the
  // caller asked for "all" because it sums/balances the rows).
  const seenCursors = new Set<string>();
  for (let page = 0; ; page++) {
    const res = await fetchPage(page, pageSize, cursor);
    const batch = Array.isArray(res) ? res : (res.data ?? []);
    out.push(...batch);
    if (batch.length === 0) return out;
    if (Array.isArray(res)) {
      if (batch.length < pageSize) return out;
      continue;
    }
    const next = res.nextCursor ?? res.meta?.nextCursor ?? null;
    if (next) {
      if (seenCursors.has(next)) {
        throw new Error(
          `[fetchAllPaged] ${opts?.label ?? "list"} cursor did not advance after ${out.length} rows — refusing to return a truncated list`,
        );
      }
      seenCursors.add(next);
      cursor = next;
      continue;
    }
    // A cursor walk ends when the server stops handing out cursors.
    if (cursor !== undefined) return out;
    if (!(res.hasNext ?? res.meta?.hasNext)) return out;
  }
}