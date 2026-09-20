import { Receipt, Box, Users, type LucideIcon } from "lucide-react";
import type { ReactNode } from "react";
import { useDashboard } from "@/presentation/hooks/useDashboard";
import { useCashboxState, useCashBalance } from "@/presentation/hooks/useCashbox";
import { useOrdersList } from "@/presentation/hooks/useOrders";
import { formatSYP } from "@/presentation/hooks/useInventory";
import { useReturnsList } from "@/presentation/hooks/useReturns";
import { formatNumber, formatMoney } from "@/shared/utils/formatNumber";
import { formatAmount, currencySymbol, type Currency } from "@/presentation/hooks/useCurrency";
import { cn } from "@/lib/utils";

function formatUnpaidCurrencies(
  byCurrency: Record<string, { count: number; totalDue: number }> = {},
): string {
  const parts = Object.entries(byCurrency)
    .filter(([, v]) => v && v.totalDue > 0)
    .map(([code, v]) => `${currencySymbol(code as Currency)} ${formatMoney(v.totalDue)}`);
  return parts.length > 0 ? parts.join(" · ") : formatSYP(0);
}

function formatDate(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getDate())}-${pad(d.getMonth() + 1)}-${d.getFullYear()}`;
}

/** Hero KPI — calm card, no rainbow chips. */
function PrimaryCard({
  id,
  title,
  icon: Icon,
  value,
  unit,
  footer,
}: {
  id: string;
  title: string;
  icon: LucideIcon;
  value: ReactNode;
  unit?: string;
  footer?: ReactNode;
}) {
  return (
    <article
      data-od-id={id}
      className="flex min-h-[148px] flex-col rounded-xl border border-border bg-card p-5 shadow-soft"
    >
      <div className="flex items-center justify-between gap-3">
        <h3 className="text-[13px] font-medium text-muted-foreground">{title}</h3>
        <Icon className="h-4 w-4 text-primary/80" strokeWidth={2} aria-hidden />
      </div>

      <div className="mt-5 flex items-baseline gap-2">
        <span className="text-[2rem] font-semibold leading-none tracking-tight tabular-nums text-foreground">
          {value}
        </span>
        {unit && <span className="text-sm text-muted-foreground">{unit}</span>}
      </div>

      <p className="mt-auto pt-4 text-[12px] leading-relaxed text-muted-foreground">
        {footer ?? "\u00a0"}
      </p>
    </article>
  );
}

/** One metric cell inside the operations strip — typography, not icon soup. */
function MetricCell({
  id,
  label,
  value,
  hint,
  emphasize,
}: {
  id: string;
  label: string;
  value: ReactNode;
  hint?: ReactNode;
  emphasize?: "warning" | "danger";
}) {
  return (
    <div
      data-od-id={id}
      className="flex min-w-0 flex-col gap-3 border-border px-5 py-4 sm:border-s sm:first:border-s-0"
    >
      <div className="text-[10px] font-medium tracking-[0.12em] text-muted-foreground">{label}</div>
      <div
        className={cn(
          "text-[1.5rem] font-semibold leading-none tabular-nums tracking-tight",
          emphasize === "warning" && "text-warning",
          emphasize === "danger" && "text-destructive",
          !emphasize && "text-foreground",
        )}
      >
        {value}
      </div>
      {hint != null && hint !== "" && (
        <div className="truncate text-[11px] leading-snug text-muted-foreground tabular-nums">
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
  const { data: cashbox } = useCashboxState();
  const { data: balSYP } = useCashBalance(today, "SYP");
  const { data: balUSD } = useCashBalance(today, "USD");
  const { data: ordersData } = useOrdersList();

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

  const availableOrders = (ordersData?.data ?? []).filter(
    (o) => o.status === "available" || o.status === "partially_available",
  ).length;

  const hasSession = Boolean(data?.session?.open || cashbox?.openingDate);
  const todayCount = todayInvoices?.count ?? 0;
  const low = lowStockRolls?.low ?? 0;
  const out = lowStockRolls?.outOfStock ?? 0;

  return (
    <div className="space-y-4" data-od-id="kpi-grid">
      <section data-od-id="kpi-primary-section">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <PrimaryCard
            id="kpi-primary-today-invoices"
            title="فواتير اليوم"
            icon={Receipt}
            value={<span dir="ltr">{formatNumber(todayCount)}</span>}
            unit="فاتورة"
            footer={`${formatDate(new Date())} · ${hasSession ? "الجلسة مفتوحة" : "الجلسة غير مفتوحة"}`}
          />
          <PrimaryCard
            id="kpi-primary-customers"
            title="العملاء النشطين"
            icon={Users}
            value={<span dir="ltr">{formatNumber(activeTodayCustomers ?? 0)}</span>}
            unit="عميل"
            footer="عميل مختلف اليوم"
          />
          <PrimaryCard
            id="kpi-primary-inventory"
            title="إجمالي المخزون"
            icon={Box}
            value={<span dir="ltr">{formatNumber(totalInventoryKg ?? 0)}</span>}
            unit="كغ"
            footer={`${activeRolls?.total ?? 0} صبغة · ${activeRolls?.fabricTypes ?? 0} أصناف`}
          />
        </div>
      </section>

      <section data-od-id="kpi-cashbox-section" aria-label="أرصدة الصندوق">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <article className="flex min-h-[108px] flex-col rounded-xl border border-border bg-card p-5 shadow-soft">
            <h3 className="text-[13px] font-medium text-muted-foreground">صندوق ل.س SYP</h3>
            <div
              className="mt-4 text-[1.75rem] font-semibold leading-none tabular-nums tracking-tight"
              dir="ltr"
            >
              {formatAmount(balSYP ?? 0, "SYP")}
            </div>
          </article>
          <article className="flex min-h-[108px] flex-col rounded-xl border border-border bg-card p-5 shadow-soft">
            <h3 className="text-[13px] font-medium text-muted-foreground">صندوق $ USD</h3>
            <div
              className="mt-4 text-[1.75rem] font-semibold leading-none tabular-nums tracking-tight"
              dir="ltr"
            >
              {formatAmount(balUSD ?? 0, "USD")}
            </div>
          </article>
        </div>
      </section>

      <section data-od-id="kpi-secondary-section" aria-label="نظرة عامة على العمليات">
        <div className="overflow-hidden rounded-xl border border-border bg-card">
          <div className="border-b border-border/80 bg-secondary/25 px-5 py-2">
            <h3 className="text-[11px] font-semibold tracking-[0.08em] text-muted-foreground">
              عمليات اليوم
            </h3>
          </div>
          <div className="grid sm:grid-cols-2 lg:grid-cols-5">
            <MetricCell
              id="kpi-secondary-unpaid"
              label="غير مسددة"
              value={<span dir="ltr">{formatNumber(unpaidInvoices?.count ?? 0)}</span>}
              hint={<span dir="ltr">{formatUnpaidCurrencies(unpaidInvoices?.byCurrency)}</span>}
              emphasize={(unpaidInvoices?.count ?? 0) > 0 ? "warning" : undefined}
            />
            <MetricCell
              id="kpi-secondary-fabrics"
              label="الأقمشة"
              value={<span dir="ltr">{formatNumber(activeRolls?.total ?? 0)}</span>}
              hint={`${activeRolls?.fabricTypes ?? 0} صنف`}
            />
            <MetricCell
              id="kpi-secondary-low-stock"
              label="مخزون منخفض"
              value={
                <span className="inline-flex items-baseline gap-1" dir="ltr">
                  <span className={low > 0 ? "text-warning" : undefined}>{low}</span>
                  <span className="text-sm font-normal text-muted-foreground">/</span>
                  <span className={out > 0 ? "text-destructive" : "text-muted-foreground"}>
                    {out}
                  </span>
                </span>
              }
              hint="منخفض / منتهٍ"
              emphasize={out > 0 ? "danger" : low > 0 ? "warning" : undefined}
            />
            <MetricCell
              id="kpi-secondary-returns"
              label="مرتجعات"
              value={<span dir="ltr">{formatNumber(returnsCount)}</span>}
              hint="اليوم"
            />
            <MetricCell
              id="kpi-secondary-available-orders"
              label="طلبات جاهزة"
              value={<span dir="ltr">{formatNumber(availableOrders)}</span>}
              hint="للتسليم"
            />
          </div>
        </div>
      </section>
    </div>
  );
}
