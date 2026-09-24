import { Button } from "@/components/ui/button";

/**
 * Server-side paging footer for long lists (vouchers, returns, ledger…).
 * Lists fetch ONE page from the API instead of the whole history, so they stay
 * fast at 100k+ documents.
 */
export const LIST_PAGE_SIZE = 100;

export function ListPager({
  page,
  total,
  pageSize = LIST_PAGE_SIZE,
  loading,
  onPage,
}: {
  page: number;
  total: number;
  pageSize?: number;
  loading?: boolean;
  onPage: (page: number) => void;
}) {
  if (total <= pageSize) return null;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  return (
    <div className="flex items-center justify-between border-t border-border px-3 py-2 text-xs text-muted-foreground">
      <span>
        صفحة {page + 1} من {pages} — {total} سجل
        {loading ? " — جاري التحميل…" : ""}
      </span>
      <div className="flex gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={page === 0}
          onClick={() => onPage(page - 1)}
        >
          السابق
        </Button>
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={page + 1 >= pages}
          onClick={() => onPage(page + 1)}
        >
          التالي
        </Button>
      </div>
    </div>
  );
}
