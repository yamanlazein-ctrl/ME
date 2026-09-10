import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Trophy } from "lucide-react";
import { useDashboard } from "@/presentation/hooks/useDashboard";
import { formatNumber } from "@/shared/utils/formatNumber";

type FabricTooltipProps = {
  active?: boolean;
  payload?: Array<{ value: number; payload: { name: string; salesK: number } }>;
};

function FabricTooltip({ active, payload }: FabricTooltipProps) {
  if (!active || !payload?.length) return null;
  const p = payload[0].payload;
  return (
    <div className="rounded-lg border border-border bg-popover px-3 py-2 shadow-elevated" dir="rtl">
      <div className="truncate text-[11px] font-medium text-muted-foreground">{p.name}</div>
      <div className="mt-1 flex items-center gap-2">
        <span className="h-2 w-2 rounded-full" style={{ background: "var(--primary)" }} />
        <span className="text-sm font-bold tabular-nums text-foreground">
          {formatNumber(p.salesK)}K
        </span>
        <span className="text-[11px] text-muted-foreground">ل.س</span>
      </div>
    </div>
  );
}

function ChartSkeleton() {
  return (
    <div className="flex h-64 items-end gap-3 px-2" dir="ltr">
      {[55, 80, 45, 70, 60].map((h, i) => (
        <div
          key={i}
          className="flex-1 animate-pulse rounded-t-md bg-primary/15"
          style={{ height: `${h}%` }}
        />
      ))}
    </div>
  );
}

function EmptyState({ icon: Icon, text }: { icon: typeof Trophy; text: string }) {
  return (
    <div className="flex h-64 flex-col items-center justify-center gap-2 text-muted-foreground">
      <Icon className="h-8 w-8 opacity-50" strokeWidth={1.5} />
      <span className="text-xs">{text}</span>
    </div>
  );
}

export function TopFabricsChart() {
  const { data: dashboardData } = useDashboard();
  const data = dashboardData?.topFabrics ?? [];
  const maxIdx = data.reduce((m, d, i) => (d.salesK > data[m].salesK ? i : m), 0);
  const loading = !dashboardData;

  return (
    <div
      data-od-id="panel-top-fabrics"
      className="rounded-xl border border-border bg-card p-4 shadow-soft"
    >
      <div className="mb-4 flex items-center gap-2.5">
        <span className="grid h-8 w-8 place-items-center rounded-lg border border-primary/30 bg-primary/10 text-primary">
          <Trophy className="h-4 w-4" strokeWidth={2} />
        </span>
        <div>
          <h3 className="text-sm font-bold text-foreground">الأكثر مبيعاً</h3>
          <p className="mt-0.5 text-[11px] text-muted-foreground">القيم بآلاف الليرات السورية</p>
        </div>
      </div>

      {loading ? (
        <ChartSkeleton />
      ) : data.length === 0 ? (
        <EmptyState icon={Trophy} text="لا توجد أقمشة لعرضها" />
      ) : (
        <div className="h-64" dir="ltr">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
              <defs>
                <linearGradient id="fabricBar" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="var(--color-primary-glow)" stopOpacity={0.95} />
                  <stop offset="100%" stopColor="var(--color-primary)" stopOpacity={0.55} />
                </linearGradient>
              </defs>
              <CartesianGrid
                vertical={false}
                stroke="var(--color-border)"
                strokeOpacity={0.5}
                strokeDasharray="3 3"
              />
              <XAxis
                dataKey="name"
                tickLine={false}
                axisLine={false}
                tick={{ fill: "var(--color-muted-foreground)", fontSize: 11 }}
                reversed
              />
              <YAxis
                orientation="right"
                tickLine={false}
                axisLine={false}
                tick={{ fill: "var(--color-muted-foreground)", fontSize: 11 }}
                width={48}
              />
              <Tooltip
                content={<FabricTooltip />}
                cursor={{ fill: "var(--color-secondary)", opacity: 0.4 }}
              />
              <Bar dataKey="salesK" radius={[6, 6, 0, 0]}>
                {data.map((_, i) => (
                  <Cell
                    key={i}
                    fill={i === maxIdx ? "var(--color-primary)" : "url(#fabricBar)"}
                    stroke={i === maxIdx ? "var(--color-primary-glow)" : "transparent"}
                    strokeWidth={i === maxIdx ? 1 : 0}
                  />
                ))}
              </Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
