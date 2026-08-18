import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/layout/AppShell";
import { PartyListPage } from "@/components/parties/PartyTable";

export const Route = createFileRoute("/suppliers/")({
  component: SuppliersPage,
});

function SuppliersPage() {
  return (
    <AppShell title="الموردون" subtitle="إدارة جميع الموردين وحركات الشراء الخاصة بهم.">
      <PartyListPage
        kind="supplier"
        title="قائمة الموردين"
        description="ابحث، صنّف، أو أضف مورداً جديداً. اضغط على السطر لعرض الملف الكامل."
      />
    </AppShell>
  );
}
