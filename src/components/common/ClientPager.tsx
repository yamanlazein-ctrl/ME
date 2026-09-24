import { useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";

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

export function ClientPager({
  page,
  totalPages,
  total,
  pageSize,
  onPage,
  onPageSize,
}: {
  page: number;
  totalPages: number;
  total: number;
  pageSize: 20 | 50 | 100;
  onPage: (p: number) => void;
  onPageSize: (n: 20 | 50 | 100) => void;
}) {
  if (total <= 20) return null;
  return (
    <div
      className="flex flex-wrap items-center justify-between gap-3 border-t border-border px-3 py-2 text-xs"
      data-testid="client-pager"
    >
      <div className="flex items-center gap-2">
        <Button type="button" size="sm" variant="outline" disabled={page === 0} onClick={() => onPage(page - 1)}>
          الصفحة السابقة
        </Button>
        <span className="tabular-nums font-semibold">
          الصفحة {page + 1} من {totalPages}
        </span>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={page + 1 >= totalPages}
          onClick={() => onPage(page + 1)}
        >
          الصفحة التالية
        </Button>
      </div>
      <div className="flex items-center gap-2 text-muted-foreground">
        <span className="tabular-nums">{total} سجل</span>
        <span>عدد الأسطر:</span>
        {([20, 50, 100] as const).map((n) => (
          <Button
            key={n}
            type="button"
            size="sm"
            variant={n === pageSize ? "default" : "outline"}
            className="h-7 px-2 tabular-nums"
            onClick={() => onPageSize(n)}
          >
            {n}
          </Button>
        ))}
      </div>
    </div>
  );
}
