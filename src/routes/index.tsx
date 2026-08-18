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
      <div className="space-y-3">
        <HeroSalesCard />
        <ExecutiveKpiGrid />
        <div className="grid gap-3 lg:grid-cols-2">
          <SalesTrendChart />
          <TopFabricsChart />
        </div>
        <div className="grid gap-3 lg:grid-cols-2">
          <RecentTransactionsList />
          <ActiveAlertsList />
        </div>
      </div>
      <footer className="pt-2 pb-4 text-center text-[11px] text-muted-foreground">
        Motard Fabrics Group • جميع الكميات محسوبة بالكيلوغرام (كغ)
      </footer>
    </AppShell>
  );
}
