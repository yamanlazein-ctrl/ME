import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/layout/AppShell";
import { HeroSalesCard } from "@/components/dashboard/HeroSalesCard";
import { ExecutiveKpiGrid } from "@/components/dashboard/ExecutiveKpiGrid";
import { TopFabricsChart } from "@/components/dashboard/TopFabricsChart";
import { SalesTrendChart } from "@/components/dashboard/SalesTrendChart";
import { RecentTransactionsList } from "@/components/dashboard/RecentTransactionsList";
import { ActiveAlertsList } from "@/components/dashboard/ActiveAlertsList";

export const Route = createFileRoute("/")({
  component: Dashboard,
});

function Dashboard() {
  return (
    <AppShell
      title="لوحة التحكم"
      subtitle="نظرة شاملة على حركة المتجر اليوم — المبيعات، المخزون، والصندوق."
    >
      {/* Layout idea: prominent hero band → KPI row → main chart (2/3) beside a
          side panel (1/3) → bottom section with the same 2/3 + 1/3 rhythm. */}
      <div className="space-y-4">
        <HeroSalesCard />
        <ExecutiveKpiGrid />
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <SalesTrendChart />
          </div>
          <TopFabricsChart />
        </div>
        <div className="grid gap-4 lg:grid-cols-3">
          <div className="lg:col-span-2">
            <RecentTransactionsList />
          </div>
          <ActiveAlertsList />
        </div>
      </div>
      <footer className="pt-2 pb-4 text-center text-[11px] text-muted-foreground">
        Motard Fabrics Group • جميع الكميات محسوبة بالكيلوغرام (كغ)
      </footer>
    </AppShell>
  );
}
