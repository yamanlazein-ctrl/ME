import { useState } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { TrendingUp } from "lucide-react";
import { useDashboard } from "@/presentation/hooks/useDashboard";
import { formatNumber } from "@/shared/utils/formatNumber";

const RANGES = ["7", "14", "30"] as const;
type Range = (typeof RANGES)[number];

type TrendTooltipProps = {
  active?: boolean;
  payload?: Array<{ value: number; name?: string }>;
  label?: string;
};

function TrendTooltip({ active, payload, label }: TrendTooltipProps) {
  if (!active || !payload?.length) return null;
  const v = payload[0].value;
  return (
    <div className="rounded-lg border border-border bg-popover px-3 py-2 shadow-elevated" dir="rtl">
      <div className="text-[11px] font-medium text-muted-foreground">{label}</div>
      <div className="mt-1 flex items-center gap-2">
        <span className="h-2 w-2 rounded-full" style={{ background: "var(--primary)" }} />
        <span className="text-sm font-bold tabular-nums text-foreground">
          {formatNumber(v ?? 0)}K
        </span>
        <span className="text-[11px] text-muted-foreground">ل.س</span>
      </div>
    </div>
  );
}

function ChartSkeleton() {
  return (
    <div className="flex h-64 items-end gap-2 px-2" dir="ltr">
      {[40, 65, 50, 80, 60, 95, 70].map((h, i) => (
        <div
          key={i}
          className="flex-1 animate-pulse rounded-t-md bg-primary/15"
          style={{ height: `${h}%` }}
        />
      ))}
    </div>
  );
}

function EmptyState({ icon: Icon, text }: { icon: typeof TrendingUp; text: string }) {
  return (
    <div className="flex h-64 flex-col items-center justify-center gap-2 text-muted-foreground">
      <Icon className="h-8 w-8 opacity-50" strokeWidth={1.5} />
      <span className="text-xs">{text}</span>
    </div>
  );
}

export function SalesTrendChart() {
  const [range, setRange] = useState<Range>("7");
  const { data } = useDashboard();
  const chartData = data?.salesTrend?.[range] ?? [];
  const loading = !data;

  return (
    <div
      data-od-id="panel-sales-trend"
      className="rounded-xl border border-border bg-card p-4 shadow-soft"
    >
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <span className="grid h-8 w-8 place-items-center rounded-lg border border-primary/25 bg-primary/10 text-primary">
            <TrendingUp className="h-4 w-4" strokeWidth={2} />
          </span>
          <div>
            <h3 className="text-sm font-bold text-foreground">اتجاه المبيعات</h3>
            <p className="mt-0.5 text-[11px] text-muted-foreground">القيم بآلاف الليرات السورية</p>
          </div>
        </div>
        <div className="inline-flex rounded-lg border border-border bg-secondary/60 p-0.5">
          {RANGES.map((r) => (
            <button
              key={r}
              type="button"
              onClick={() => setRange(r)}
              className={`rounded-md px-3 py-1 text-xs font-medium transition cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background ${
                range === r
                  ? "bg-primary text-primary-foreground shadow-soft"
                  : "text-muted-foreground hover:text-foreground"
              }`}
            >
              {r} يوم
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <ChartSkeleton />
      ) : chartData.length === 0 ? (
        <EmptyState icon={TrendingUp} text="لا توجد بيانات كافية لعرض الاتجاه" />
      ) : (
        <div className="h-64" dir="ltr">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chartData} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
              <defs>
                <linearGradient id="salesFill" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--color-primary)" stopOpacity={0.45} />
                  <stop offset="55%" stopColor="var(--color-primary-glow)" stopOpacity={0.18} />
                  <stop offset="100%" stopColor="var(--color-primary)" stopOpacity={0} />
                </linearGradient>
              </defs>
              <CartesianGrid
                vertical={false}
                stroke="var(--color-border)"
                strokeOpacity={0.5}
                strokeDasharray="3 3"
              />
              <XAxis
                dataKey="label"
                tickLine={false}
                axisLine={false}
                tick={{ fill: "var(--color-muted-foreground)", fontSize: 11 }}
                reversed
                interval="preserveStartEnd"
              />
              <YAxis
                orientation="right"
                tickLine={false}
                axisLine={false}
                tick={{ fill: "var(--color-muted-foreground)", fontSize: 11 }}
                width={48}
              />
              <Tooltip
                content={<TrendTooltip />}
                cursor={{
                  stroke: "var(--color-primary)",
                  strokeWidth: 1,
                  strokeDasharray: "3 3",
                }}
              />
              <Area
                type="monotone"
                dataKey="value"
                stroke="var(--color-primary)"
                strokeWidth={2.5}
                fill="url(#salesFill)"
                dot={false}
                activeDot={{
                  r: 5,
                  stroke: "var(--color-primary)",
                  strokeWidth: 2,
                  fill: "var(--color-card)",
                }}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
