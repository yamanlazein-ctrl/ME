import { ChevronLeft, ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { formatNumber, formatMoney, formatQuantity } from "@/shared/utils/formatNumber";


/**
 * Shared, RTL-aware pagination bar used at the bottom of list tables.
 *
 * `page` is zero-based; `pageCount`/`from`/`to` are derived from `total` and
 * `pageSize`. Uses the same design tokens (border-border / bg-secondary /
 * primary) as the rest of the app.
 */
export function DataPagination({
  total,
  page,
  pageSize,
  onPageChange,
  onPageSizeChange,
  pageSizeOptions = [10, 20, 50],
}: {
  total: number;
  page: number; // zero-based
  pageSize: number;
  onPageChange: (page: number) => void;
  onPageSizeChange?: (size: number) => void;
  pageSizeOptions?: number[];
}) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(Math.max(0, page), pageCount - 1);
  const from = total === 0 ? 0 : current * pageSize + 1;
  const to = Math.min(total, (current + 1) * pageSize);

  // Compact page list with ellipsis around the active page.
  const pages: Array<number | "…"> = [];
  const oneBased = current + 1;
  const start = Math.max(1, oneBased - 1);
  const end = Math.min(pageCount, oneBased + 1);
  if (start > 1) pages.push(1);
  if (start > 2) pages.push("…");
  for (let p = start; p <= end; p++) pages.push(p);
  if (end < pageCount - 1) pages.push("…");
  if (end < pageCount) pages.push(pageCount);

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-border bg-secondary/20 px-5 py-2.5 text-xs text-muted-foreground">
      <div className="flex items-center gap-3">
        <span className="tabular-nums">
          عرض {formatQuantity(from)}–{formatNumber(to)} من{" "}
          {formatNumber(total)}
        </span>
        {onPageSizeChange && (
          <Select
            value={String(pageSize)}
            onValueChange={(v) => onPageSizeChange(Number(v))}
          >
            <SelectTrigger className="!h-8 w-[96px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {pageSizeOptions.map((n) => (
                <SelectItem key={n} value={String(n)}>
                  {n} / صفحة
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
      </div>

      <div className="flex items-center gap-1">
        <Button
          size="sm"
          variant="outline"
          className="gap-1"
          disabled={current === 0}
          onClick={() => onPageChange(current - 1)}
        >
          <ChevronRight className="h-4 w-4" />
          السابق
        </Button>
        {pages.map((p, i) =>
          p === "…" ? (
            <span key={`e${i}`} className="px-1 text-muted-foreground">
              …
            </span>
          ) : (
            <Button
              key={p}
              size="sm"
              variant={p - 1 === current ? "default" : "ghost"}
              className="h-8 w-8"
              onClick={() => onPageChange(p - 1)}
            >
              {p}
            </Button>
          ),
        )}
        <Button
          size="sm"
          variant="outline"
          className="gap-1"
          disabled={current >= pageCount - 1}
          onClick={() => onPageChange(current + 1)}
        >
          التالي
          <ChevronLeft className="h-4 w-4" />
        </Button>
      </div>
    </div>
  );
}
