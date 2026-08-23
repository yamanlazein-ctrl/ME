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
import { useReturnsList } from "@/presentation/hooks/useReturns";
import { formatNumber, formatMoney } from "@/shared/utils/formatNumber";

function formatUnpaidCurrencies(
  byCurrency: Record<string, { count: number; totalDue: number }> = {},
): string {
  const parts = Object.entries(byCurrency)
    .filter(([, v]) => v && v.totalDue > 0)
    .map(([code, v]) => `${formatMoney(v.totalDue)} ${code}`);
  return parts.length > 0 ? parts.join(" · ") : formatSYP(0);
}

type Tone = "neutral" | "primary" | "success" | "warning" | "destructive";

function chipTone(tone: Tone) {
  switch (tone) {
    case "success":
      return "bg-success/10 text-success border-success/30";
    case "warning":
      return "bg-warning/10 text-warning border-warning/30";
    case "destructive":
      return "bg-destructive/10 text-destructive border-destructive/30";
    default:
      return "bg-primary/10 text-primary border-primary/30";
  }
}

function PrimaryCard({
  id,
  title,
  icon: Icon,
  value,
  tone = "neutral",
  footer,
}: {
  id: string;
  title: string;
  icon: LucideIcon;
  value: ReactNode;
  tone?: Tone;
  footer?: ReactNode;
}) {
  return (
    <div
      data-od-id={id}
      className="card-glow relative flex h-full min-h-[148px] flex-col overflow-hidden rounded-2xl border border-primary/20 bg-card p-5 shadow-elevated transition duration-300 hover:-translate-y-1 hover:border-primary/40"
    >
      <div
        className="pointer-events-none absolute inset-x-0 top-0 h-[2px]"
        style={{
          background:
            "linear-gradient(90deg, transparent, var(--primary), transparent)",
        }}
      />
      <div className="relative flex items-center gap-3">
        <span
          className={`grid h-11 w-11 shrink-0 place-items-center rounded-xl border ${chipTone(
            tone,
          )}`}
        >
          <Icon className="h-5 w-5" strokeWidth={2} />
        </span>
        <h3 className="min-w-0 flex-1 text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
          {title}
        </h3>
      </div>
      <div className="relative mt-4">{value}</div>
      <div className="relative mt-auto pt-4 text-[11px] text-muted-foreground">
        {footer ?? <span className="opacity-0">—</span>}
      </div>
    </div>
  );
}

function SecondaryCard({
  id,
  title,
  icon: Icon,
  value,
  hint,
  tone = "neutral",
}: {
  id: string;
  title: string;
  icon: LucideIcon;
  value: ReactNode;
  hint?: ReactNode;
  tone?: Tone;
}) {
  return (
    <div
      data-od-id={id}
      className="group relative flex h-full flex-col overflow-hidden rounded-xl border border-border/70 bg-card p-3.5 shadow-soft transition duration-200 hover:-translate-y-0.5 hover:border-primary/30 hover:shadow-elevated"
    >
      <div className="flex items-center gap-2">
        <span
          className={`grid h-7 w-7 shrink-0 place-items-center rounded-lg border ${chipTone(
            tone,
          )}`}
        >
          <Icon className="h-3.5 w-3.5" strokeWidth={2} />
        </span>
        <span className="min-w-0 flex-1 truncate text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
          {title}
        </span>
      </div>
      <div className="mt-2.5 text-2xl font-bold leading-none tracking-tight text-foreground tabular-nums">
        {value}
      </div>
      {hint && (
        <div className="mt-1.5 truncate text-[10px] font-medium text-muted-foreground tabular-nums">
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
    <div className="space-y-5" data-od-id="kpi-grid">
      <section data-od-id="kpi-primary-section">
        <div className="grid gap-3 md:grid-cols-2">
          <PrimaryCard
            id="kpi-primary-customers"
            title="العملاء النشطين"
            icon={Users}
            value={
              <span
                className="inline-flex items-baseline gap-1.5 text-4xl font-bold leading-none tabular-nums sm:text-5xl"
                style={{ color: "var(--currency-syp)" }}
              >
                <span>{formatNumber(activeTodayCustomers ?? 0)}</span>
                <span className="text-base font-semibold text-muted-foreground">
                  عميل
                </span>
              </span>
            }
            tone="success"
            footer={<span>عميل مختلف اليوم</span>}
          />
          <PrimaryCard
            id="kpi-primary-inventory"
            title="إجمالي المخزون"
            icon={Box}
            value={
              <span
                className="inline-flex items-baseline gap-1.5 text-4xl font-bold leading-none tabular-nums sm:text-5xl"
                style={{ color: "var(--currency-syp)" }}
              >
                <span>{formatNumber(totalInventoryKg ?? 0)}</span>
                <span className="text-base font-semibold text-muted-foreground">
                  كغ
                </span>
              </span>
            }
            tone="primary"
            footer={
              <span>
                {activeRolls?.total ?? 0} صبغة في{" "}
                {activeRolls?.fabricTypes ?? 0} أصناف
              </span>
            }
          />
        </div>
      </section>

      <section data-od-id="kpi-secondary-section">
        <div className="mb-3 flex items-center gap-3">
          <h3 className="text-[11px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
            نظرة عامة على العمليات
          </h3>
          <div className="h-px flex-1 bg-border/60" />
        </div>
        <div className="grid gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5">
          <SecondaryCard
            id="kpi-secondary-today-invoices"
            title="فواتير اليوم"
            icon={Receipt}
            value={formatNumber(todayInvoices?.count ?? 0)}
            hint="فاتورة"
          />
          <SecondaryCard
            id="kpi-secondary-unpaid"
            title="فواتير غير مسددة"
            icon={FileWarning}
            value={formatMoney(unpaidInvoices?.count ?? 0)}
            hint={formatUnpaidCurrencies(unpaidInvoices?.byCurrency)}
            tone="warning"
          />
          <SecondaryCard
            id="kpi-secondary-fabrics"
            title="إجمالي الأقمشة"
            icon={Layers}
            value={formatMoney(activeRolls?.total ?? 0)}
            hint={`${activeRolls?.fabricTypes ?? 0} صنف`}
          />
          <SecondaryCard
            id="kpi-secondary-low-stock"
            title="صبغات منخفضة"
            icon={AlertTriangle}
            value={
              <span className="flex items-baseline gap-1.5">
                <span className="text-warning">{lowStockRolls?.low ?? 0}</span>
                <span className="text-muted-foreground/40">/</span>
                <span className="text-destructive">
                  {lowStockRolls?.outOfStock ?? 0}
                </span>
              </span>
            }
            hint="منخفضة / منتهية"
            tone="warning"
          />
          <SecondaryCard
            id="kpi-secondary-returns"
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
