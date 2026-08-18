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

function LevelBadge({ a }: { a: AlertDTO }) {
  if (a.category === "inventory") {
    if (a.level === "out") {
      return (
        <span className="inline-flex items-center gap-1 rounded-md bg-destructive/15 px-2 py-0.5 text-[11px] font-semibold text-destructive">
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
    <span className="inline-flex items-center gap-1 rounded-md bg-destructive/15 px-2 py-0.5 text-[11px] font-semibold text-destructive tabular-nums">
      <AlertCircle className="h-3 w-3" /> متأخرة {a.daysOverdue} يوم
    </span>
  );
}

function AlertRow({ a }: { a: AlertDTO }) {
  if (a.category === "inventory") {
    return (
      <Link
        to="/inventory"
        className="group flex items-center gap-4 px-5 py-4 hover:bg-secondary/60 transition cursor-pointer"
      >
        <div className="grid h-10 w-10 place-items-center rounded-lg bg-secondary text-muted-foreground group-hover:text-foreground">
          <PackageX className="h-4.5 w-4.5" strokeWidth={2} />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <span className="text-sm font-semibold text-foreground truncate">
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
        <ChevronLeft className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition" />
      </Link>
    );
  }
  return (
    <Link
      to="/invoices/$id"
      params={{ id: a.invoiceNo ?? "" }}
      className="group flex items-center gap-4 px-5 py-4 hover:bg-secondary/60 transition cursor-pointer"
    >
      <div className="grid h-10 w-10 place-items-center rounded-lg bg-destructive/10 text-destructive">
        <AlertCircle className="h-4.5 w-4.5" strokeWidth={2} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="text-sm font-semibold text-foreground truncate">{a.customer}</span>
          <span className="rounded-md bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground tabular-nums">
            {a.invoiceNo}
          </span>
        </div>
        <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">
          مبلغ مستحق: {formatAmount(a.amount ?? 0, (a.currency ?? "SYP") as Currency)}
        </div>
      </div>
      <LevelBadge a={a} />
      <ChevronLeft className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition" />
    </Link>
  );
}

export function ActiveAlertsList() {
  const [filter, setFilter] = useState<Filter>("all");
  const { data } = useDashboard();
  const items = (data?.alerts ?? []).filter((a) => filter === "all" || a.category === filter);

  return (
    <div className="rounded-xl border border-border bg-card shadow-soft">
      <div className="flex items-center justify-between border-b border-border px-5 py-4">
        <div className="flex items-center gap-2">
          <Bell className="h-4 w-4 text-muted-foreground" />
          <h3 className="text-sm font-semibold text-foreground">التنبيهات النشطة</h3>
          <span className="rounded-md bg-destructive/15 px-1.5 py-0.5 text-[10px] font-semibold text-destructive tabular-nums">
            {(data?.alerts ?? []).length}
          </span>
        </div>
        <div className="inline-flex rounded-lg border border-border bg-secondary p-0.5">
          {FILTERS.map((f) => (
            <button
              key={f.key}
              type="button"
              onClick={() => setFilter(f.key)}
              className={`rounded-md px-2.5 py-1 text-[11px] font-medium transition cursor-pointer ${
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
        <div className="px-5 py-10 text-center text-xs text-muted-foreground">
          لا توجد تنبيهات ضمن هذا التصنيف.
        </div>
      ) : (
        <ul className="max-h-[24rem] overflow-y-auto divide-y divide-border">
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
