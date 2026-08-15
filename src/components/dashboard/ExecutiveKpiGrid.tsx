import {
  Receipt,
  FileWarning,
  Layers,
  AlertTriangle,
  Undo2,
  Box,
  Users,
  type LucideIcon,
} from "lucide-react";

import type { ReactNode } from "react";
import { useDashboard } from "@/presentation/hooks/useDashboard";
import { formatSYP } from "@/presentation/hooks/useInventory";
import { DualCurrency } from "@/components/common/DualCurrency";
import { useReturnsList } from "@/presentation/hooks/useReturns";
import { formatNumber, formatMoney, formatQuantity } from "@/shared/utils/formatNumber";


function formatUnpaidCurrencies(
  byCurrency: Record<string, { count: number; totalDue: number }> = {},
): string {
  const parts = Object.entries(byCurrency)
    .filter(([, v]) => v && v.totalDue > 0)
    .map(([code, v]) => `${formatMoney(v.totalDue)} ${code}`);
  return parts.length > 0 ? parts.join(" · ") : formatSYP(0);
}

type Tone = "neutral" | "primary" | "success" | "warning" | "destructive";

function toneIcon(tone: Tone) {
  switch (tone) {
    case "primary":
      return "bg-primary/10 text-primary";
    case "success":
      return "bg-primary/15 text-primary";
    case "warning":
      return "bg-primary/10 text-[color:var(--primary-glow)]";
    case "destructive":
      return "bg-primary/10 text-[color:var(--accent-soft)]";
    default:
      return "bg-primary/5 text-primary";
  }
}

function PrimaryCard({
  title,
  icon: Icon,
  syp,
  value,
  tone = "neutral",
  footer,
}: {
  title: string;
  icon: LucideIcon;
  syp?: number;
  value?: ReactNode;
  tone?: Tone;
  footer?: ReactNode;
}) {
  return (
    <div className="card-glow relative flex h-full min-h-[128px] flex-col overflow-hidden rounded-2xl border border-primary/20 bg-card p-4 shadow-[0_2px_10px_-4px_rgba(0,0,0,0.15)] transition duration-200 hover:-translate-y-0.5 hover:border-primary/40 hover:shadow-[0_10px_24px_-14px_color-mix(in_oklab,var(--primary)_45%,transparent)]">
      {/* Thin gold top bar */}
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-[2px]"
        style={{ background: "linear-gradient(90deg, transparent, var(--primary), transparent)" }}
      />
      <div className="flex items-center gap-3">
        <span
          className={`grid h-9 w-9 shrink-0 place-items-center rounded-full border border-primary/25 ${toneIcon(tone)}`}
        >
          <Icon className="h-[18px] w-[18px]" strokeWidth={1.8} />
        </span>
        <h3 className="min-w-0 flex-1 text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
          {title}
        </h3>
      </div>
      <div className="mt-3">{value ?? <DualCurrency syp={syp} size="lg" align="start" />}</div>
      <div className="mt-auto pt-2 text-[11px] text-muted-foreground">
        {footer ?? <span className="opacity-0">—</span>}
      </div>
    </div>
  );
}

function SecondaryCard({
  title,
  icon: Icon,
  value,
  hint,
  tone = "neutral",
}: {
  title: string;
  icon: LucideIcon;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
}) {
  return (
    <div className="group relative flex h-full flex-col overflow-hidden rounded-xl border border-border/60 bg-card p-3 transition duration-200 hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-[0_4px_12px_-6px_rgba(0,0,0,0.2)]">
      <div className="flex items-center gap-2">
        <span className={`grid h-6 w-6 shrink-0 place-items-center rounded-full ${toneIcon(tone)}`}>
          <Icon className="h-3.5 w-3.5" strokeWidth={1.8} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-muted-foreground">
          {title}
        </span>
      </div>
      <div className="mt-2 text-[17px] font-bold leading-none tracking-tight text-foreground tabular-nums">
        {value}
      </div>
      {hint && (
        <div className="mt-1 text-[10px] font-medium text-muted-foreground tabular-nums">
          {hint}
        </div>
      )}
    </div>
  );
}

export function ExecutiveKpiGrid() {
  const { data } = useDashboard();
  const today = new Date().toISOString().slice(0, 10);
  const { data: returnsData } = useReturnsList();

  const {
    todayInvoices,
    unpaidInvoices,
    lowStockRolls,
    activeRolls,
    totalInventoryKg,
    activeTodayCustomers,
  } = data ?? {};

  const returnsCount = (returnsData?.data ?? []).filter(
    (r) => r.status === "active" && r.date === today,
  ).length;

  return (
    <div className="space-y-5">
      {/* Section 1 — Executive Summary (2 primary KPIs after the hero) */}
      <section>
        <div className="grid gap-3 md:grid-cols-2">
          <PrimaryCard
            title="العملاء النشطين"
            icon={Users}
            value={
              <span
                className="inline-flex items-baseline gap-1 text-xl font-bold tabular-nums"
                style={{ color: "var(--currency-syp)" }}
              >
                <span>{formatNumber(activeTodayCustomers ?? 0)}</span>
              </span>
            }
            tone="success"
            footer={<span>عميل مختلف اليوم</span>}
          />
          <PrimaryCard
            title="إجمالي المخزون"
            icon={Box}
            value={
              <span
                className="inline-flex items-baseline gap-1 text-xl font-bold tabular-nums"
                style={{ color: "var(--currency-syp)" }}
              >
                <span>{formatNumber(totalInventoryKg ?? 0)}</span>
                <span className="text-[13px] font-semibold opacity-70">كغ</span>
              </span>
            }
            tone="primary"
            footer={
              <span>
                {activeRolls?.total ?? 0} صبغة في {activeRolls?.fabricTypes ?? 0} أصناف
              </span>
            }
          />
        </div>
      </section>

      {/* Section 2 — Operations Snapshot */}
      <section>
        <div className="mb-3 flex items-center gap-3">
          <h3 className="text-[12px] font-semibold uppercase tracking-wider text-muted-foreground">
            نظرة عامة على العمليات
          </h3>
          <div className="h-px flex-1 bg-border/60" />
        </div>
        <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
          <SecondaryCard
            title="فواتير اليوم"
            icon={Receipt}
            value={formatMoney(todayInvoices?.count ?? 0)}
            hint="فاتورة"
          />
          <SecondaryCard
            title="فواتير غير مسددة"
            icon={FileWarning}
            value={formatMoney(unpaidInvoices?.count ?? 0)}
            hint={formatUnpaidCurrencies(unpaidInvoices?.byCurrency)}
            tone="warning"
          />
          <SecondaryCard
            title="إجمالي الأقمشة"
            icon={Layers}
            value={formatMoney(activeRolls?.total ?? 0)}
            hint={`${activeRolls?.fabricTypes ?? 0} صنف`}
          />
          <SecondaryCard
            title="صبغات منخفضة"
            icon={AlertTriangle}
            value={
              <span className="flex items-baseline gap-1.5">
                <span className="text-warning">{lowStockRolls?.low ?? 0}</span>
                <span className="text-muted-foreground/40">/</span>
                <span className="text-destructive">{lowStockRolls?.outOfStock ?? 0}</span>
              </span>
            }
            hint="منخفضة / منتهية"
            tone="warning"
          />
          <SecondaryCard
            title="المرتجعات"
            icon={Undo2}
            value={formatMoney(returnsCount)}
            hint="مرتجع اليوم"
          />
        </div>
      </section>
    </div>
  );
}
