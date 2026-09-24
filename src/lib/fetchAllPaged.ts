/**
 * REPAIR-001 — page through list APIs until !hasNext (never treat one page as "all").
 *
 * Accepts the three shapes our list adapters return: a bare array, the raw
 * API envelope `{ data, meta: { hasNext } }`, and the repository result
 * `{ data, hasNext }`. Pages are 0-based (`page * limit` offset on the server).
 */
export type PageMeta = { hasNext?: boolean; totalPages?: number; page?: number; limit?: number };

type PageResult<T> = { data: T[]; meta?: PageMeta; hasNext?: boolean } | T[];

export async function fetchAllPaged<T>(
  fetchPage: (page: number, limit: number) => Promise<PageResult<T>>,
  opts?: { pageSize?: number; maxPages?: number; label?: string },
): Promise<T[]> {
  const pageSize = opts?.pageSize ?? 200;
  const maxPages = opts?.maxPages ?? 50;
  const out: T[] = [];
  for (let page = 0; page < maxPages; page++) {
    const res = await fetchPage(page, pageSize);
    const batch = Array.isArray(res) ? res : (res.data ?? []);
    out.push(...batch);
    const hasNext = Array.isArray(res)
      ? batch.length >= pageSize
      : Boolean(res.hasNext ?? res.meta?.hasNext);
    if (!hasNext || batch.length === 0) return out;
  }
  // Never truncate: the caller asked for "all" because it sums/balances the
  // rows. Returning a partial list would render WRONG totals that look valid,
  // so fail loudly instead (the screen shows an error, not a wrong balance).
  throw new Error(
    `[fetchAllPaged] ${opts?.label ?? "list"} exceeded ${maxPages} pages (${out.length} rows) — refusing to return a truncated list`,
  );
}
