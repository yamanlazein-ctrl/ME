import { useState } from "react";
import { Link } from "@tanstack/react-router";
import { AlertCircle, Bell, ChevronLeft, PackageX, TrendingDown } from "lucide-react";
import { useDashboard } from "@/presentation/hooks/useDashboard";
import { formatAmount } from "@/presentation/hooks/useCurrency";
import type { AlertDTO } from "@/application/ports/IDashboardRepository";
import type { Currency } from "@/domain/types";

const FILTERS = [
  { key: "all", label: "الكل" },
  { key: "financial", label: "المالية" },
  { key: "inventory", label: "المخزون" },
] as const;
type Filter = (typeof FILTERS)[number]["key"];

function isCritical(a: AlertDTO): boolean {
  if (a.category === "inventory") return a.level === "out";
  return a.level === "overdue";
}

function LevelBadge({ a }: { a: AlertDTO }) {
  if (a.category === "inventory") {
    if (a.level === "out") {
      return (
        <span className="inline-flex items-center gap-1 rounded-md bg-destructive px-2 py-0.5 text-[11px] font-bold text-destructive-foreground tabular-nums">
          <PackageX className="h-3 w-3" /> منتهية
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1 rounded-md bg-warning/20 px-2 py-0.5 text-[11px] font-semibold text-warning">
        <TrendingDown className="h-3 w-3" /> منخفضة
      </span>
    );
  }
  return (
    <span className="inline-flex items-center gap-1 rounded-md bg-destructive px-2 py-0.5 text-[11px] font-bold text-destructive-foreground tabular-nums">
      <AlertCircle className="h-3 w-3" /> متأخرة {a.daysOverdue} يوم
    </span>
  );
}

function AlertRow({ a }: { a: AlertDTO }) {
  const critical = isCritical(a);
  const rowBase =
    "group relative flex items-center gap-4 border-r-2 px-5 py-4 transition-colors duration-200 outline-none";
  const rowTone = critical
    ? "border-destructive bg-destructive/5 hover:bg-destructive/10"
    : "border-warning/40 bg-warning/5 hover:bg-warning/10";
  const chipTone = critical
    ? "bg-destructive/15 text-destructive border-destructive/30"
    : "bg-warning/15 text-warning border-warning/30";

  if (a.category === "inventory") {
    return (
      <Link
        to="/inventory"
        className={`${rowBase} ${rowTone} focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring`}
      >
        <div className={`grid h-10 w-10 shrink-0 place-items-center rounded-lg border ${chipTone}`}>
          <PackageX className="h-4 w-4" strokeWidth={2} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="truncate text-sm font-semibold text-foreground">
              {a.fabric} — {a.color}
            </span>
            <span className="rounded-md bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground tabular-nums">
              صبغة #{a.rollNo}
            </span>
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            كود اللون {a.colorCode} • {a.remaining}
          </div>
        </div>
        <LevelBadge a={a} />
        <ChevronLeft className="h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
      </Link>
    );
  }
  return (
    <Link
      to="/invoices/$id"
      params={{ id: a.invoiceNo ?? "" }}
      className={`${rowBase} ${rowTone} focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring`}
    >
      <div className={`grid h-10 w-10 shrink-0 place-items-center rounded-lg border ${chipTone}`}>
        <AlertCircle className="h-4 w-4" strokeWidth={2} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-semibold text-foreground">{a.customer}</span>
          <span className="rounded-md bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground tabular-nums">
            {a.invoiceNo}
          </span>
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">
          مبلغ مستحق: {formatAmount(a.amount ?? 0, (a.currency ?? "SYP") as Currency)}
        </div>
      </div>
      <LevelBadge a={a} />
      <ChevronLeft className="h-4 w-4 shrink-0 text-muted-foreground transition-colors group-hover:text-foreground" />
    </Link>
  );
}

export function ActiveAlertsList() {
  const [filter, setFilter] = useState<Filter>("all");
  const { data } = useDashboard();
  const all = data?.alerts ?? [];
  const items = all.filter((a) => filter === "all" || a.category === filter);

  return (
    <div
      data-od-id="panel-active-alerts"
      className="flex flex-col rounded-xl border border-border bg-card shadow-soft"
    >
      <div className="flex items-center justify-between border-b border-border px-5 py-4">
        <div className="flex items-center gap-2.5">
          <span className="grid h-8 w-8 place-items-center rounded-lg border border-primary/25 bg-primary/10 text-primary">
            <Bell className="h-4 w-4" strokeWidth={2} />
          </span>
          <h3 className="text-sm font-bold text-foreground">التنبيهات النشطة</h3>
          <span className="rounded-md bg-destructive/15 px-1.5 py-0.5 text-[10px] font-semibold text-destructive tabular-nums">
            {all.length}
          </span>
        </div>
        <div className="inline-flex rounded-lg border border-border bg-secondary/60 p-0.5">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
                filter === f.key
                  ? "bg-primary text-primary-foreground shadow-soft"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {f.label}
            </button>
          ))}
        </div>
      </div>

      {items.length === 0 ? (
        <div className="flex flex-col items-center justify-center gap-2 px-5 py-12 text-muted-foreground">
          <Bell className="h-8 w-8 opacity-50" strokeWidth={1.5} />
          <span className="text-xs">لا توجد تنبيهات ضمن هذا التصنيف</span>
        </div>
      ) : (
        <ul className="max-h-[24rem] divide-y divide-border overflow-y-auto">
          {items.map((a, i) => (
            <li key={i}>
              <AlertRow a={a} />
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
