/**
 * REPAIR-001 — page through list APIs until !hasNext (never treat one page as "all").
 */
export type PageMeta = { hasNext?: boolean; totalPages?: number; page?: number; limit?: number };

export async function fetchAllPaged<T>(
  fetchPage: (page: number, limit: number) => Promise<{ data: T[]; meta?: PageMeta } | T[]>,
  opts?: { pageSize?: number; maxPages?: number },
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
      : Boolean(res.meta?.hasNext);
    if (!hasNext || batch.length === 0) break;
  }
  return out;
}
