import { Layers, FileWarning, AlertTriangle, Receipt } from "lucide-react";
import { useDashboard } from "@/presentation/hooks/useDashboard";
import { formatSYP } from "@/presentation/hooks/useInventory";
import { KpiCard } from "./KpiCard";
import { formatNumber, formatMoney, formatQuantity } from "@/shared/utils/formatNumber";


function formatUnpaidCurrencies(
  byCurrency: Record<string, { count: number; totalDue: number }> = {},
): string {
  const parts = Object.entries(byCurrency)
    .filter(([, v]) => v && v.totalDue > 0)
    .map(([code, v]) => `${formatMoney(v.totalDue)} ${code}`);
  return parts.length > 0 ? parts.join(" · ") : formatSYP(0);
}

export function SecondaryKpiRow() {
  const { data } = useDashboard();
  const { activeRolls, unpaidInvoices, lowStockRolls, todayInvoices } = data ?? {};
  return (
    <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-4">
      <KpiCard
        title="إجمالي الصبغات النشطة"
        icon={Layers}
        primary={formatNumber(activeRolls?.total ?? 0)}
        secondary={`${activeRolls?.fabricTypes ?? 0} صنف — ${activeRolls?.colors ?? 0} لون`}
      />
      <KpiCard
        title="فواتير غير مسددة بالكامل"
        icon={FileWarning}
        primary={`${unpaidInvoices?.count ?? 0} فاتورة`}
        secondary={formatUnpaidCurrencies(unpaidInvoices?.byCurrency)}
        footer="يستوجب المتابعة"
      />
      <KpiCard
        title="صبغات منخفضة / منتهية"
        icon={AlertTriangle}
        primary={
          <span className="flex items-baseline gap-2">
            <span className="text-warning">{lowStockRolls?.low ?? 0}</span>
            <span className="text-muted-foreground text-sm font-normal">منخفضة</span>
            <span className="text-muted-foreground">/</span>
            <span className="text-destructive">{lowStockRolls?.outOfStock ?? 0}</span>
            <span className="text-muted-foreground text-sm font-normal">منتهية</span>
          </span>
        }
        footer="تحتاج إعادة طلب"
      />
      <KpiCard
        title="فواتير اليوم"
        icon={Receipt}
        primary={`${todayInvoices?.count ?? 0} فاتورة`}
        secondary={`${todayInvoices?.returns ?? 0} مرتجع`}
      />
    </div>
  );
}
