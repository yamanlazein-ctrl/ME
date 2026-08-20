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
import { useDashboard } from "@/presentation/hooks/useDashboard";
import { formatNumber, formatMoney, formatQuantity } from "@/shared/utils/formatNumber";

export function TopFabricsChart() {
  const { data: dashboardData } = useDashboard();
  const data = dashboardData?.topFabrics ?? [];
  const maxIdx = data.reduce((m, d, i) => (d.salesK > data[m].salesK ? i : m), 0);

  return (
    <div className="rounded-xl border border-border bg-card p-5 shadow-soft">
      <div className="mb-4 flex items-start justify-between gap-3">
        <div>
          <h3 className="text-sm font-semibold text-foreground">أكثر الأقمشة مبيعاً هذا الشهر</h3>
          <p className="mt-0.5 text-xs text-muted-foreground">القيم بآلاف الليرات السورية</p>
        </div>
      </div>
      <div className="h-64" dir="ltr">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={data} margin={{ top: 8, right: 8, left: 8, bottom: 8 }}>
            <CartesianGrid vertical={false} stroke="var(--color-border)" strokeDasharray="3 3" />
            <XAxis
              dataKey="name"
              tickLine={false}
              axisLine={false}
              tick={{ fill: "var(--color-muted-foreground)", fontSize: 11, fontFamily: "inherit" }}
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
              cursor={{ fill: "var(--color-secondary)", opacity: 0.5 }}
              contentStyle={{
                background: "var(--color-popover)",
                border: "1px solid var(--color-border)",
                borderRadius: 8,
                fontSize: 12,
                color: "var(--color-popover-foreground)",
              }}
              formatter={(v: number) => [`${formatNumber(v)}K ل.س`, "المبيعات"]}
            />
            <Bar dataKey="salesK" radius={[6, 6, 0, 0]}>
              {data.map((_, i) => (
                <Cell
                  key={i}
                  fill={
                    i === maxIdx
                      ? "var(--color-primary)"
                      : "color-mix(in oklab, var(--primary) 35%, transparent)"
                  }
                  stroke={
                    i === maxIdx
                      ? "var(--color-primary)"
                      : "color-mix(in oklab, var(--primary) 55%, transparent)"
                  }
                />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}
