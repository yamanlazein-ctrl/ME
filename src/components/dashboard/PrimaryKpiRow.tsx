import { Banknote, TrendingUp, ShoppingBag } from "lucide-react";
import { useDashboard } from "@/presentation/hooks/useDashboard";
import { formatSYP } from "@/presentation/hooks/useInventory";
import { formatAmount } from "@/presentation/hooks/useCurrency";
import { KpiCard } from "./KpiCard";

export function PrimaryKpiRow() {
  const { data } = useDashboard();
  const { cashBalance, todayProfit, todaySales } = data ?? {};
  const changeVsYesterday = todaySales?.changeVsYesterday ?? 0;
  return (
    <div className="grid gap-4 md:grid-cols-3">
      <KpiCard
        title="رصيد الصندوق الحالي"
        icon={Banknote}
        primary={formatSYP(cashBalance?.syp ?? 0)}
        secondary={formatAmount(cashBalance?.usd ?? 0, "USD")}
        emphasis
      />
      <KpiCard
        title="الأرباح الصافية اليوم"
        icon={TrendingUp}
        primary={formatSYP(todayProfit?.syp ?? 0)}
        secondary={`هامش ${todayProfit?.marginPercent ?? 0}٪`}
        trend={todayProfit?.trend}
        trendValue={`${todayProfit?.marginPercent ?? 0}٪`}
      />
      <KpiCard
        title="إجمالي المبيعات اليوم"
        icon={ShoppingBag}
        primary={formatSYP(todaySales?.syp ?? 0)}
        secondary={formatAmount(todaySales?.usd ?? 0, "USD")}
        trend={changeVsYesterday >= 0 ? "up" : "down"}
        trendValue={`${changeVsYesterday >= 0 ? "+" : ""}${changeVsYesterday}٪ عن الأمس`}
      />
    </div>
  );
}
