import { useEffect, useMemo, useState } from "react";

/**
 * Renders long in-memory lists one page at a time (20 / 50 / 100 rows).
 * The data may already be loaded; putting thousands of rows into the DOM at
 * once is what freezes the screen and the scroll.
 */
export function useClientPage<T>(items: readonly T[], resetKey?: unknown) {
  const [page, setPage] = useState(0);
  const [pageSize, setPageSize] = useState<20 | 50 | 100>(20);
  const totalPages = Math.max(1, Math.ceil(items.length / pageSize));
  useEffect(() => {
    setPage(0);
  }, [resetKey, pageSize]);
  useEffect(() => {
    if (page > totalPages - 1) setPage(totalPages - 1);
  }, [page, totalPages]);
  const pageItems = useMemo(
    () => items.slice(page * pageSize, page * pageSize + pageSize),
    [items, page, pageSize],
  );
  return { page, setPage, pageSize, setPageSize, totalPages, total: items.length, pageItems };
}
