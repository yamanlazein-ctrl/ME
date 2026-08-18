import { createFileRoute } from "@tanstack/react-router";
import { AppShell } from "@/components/layout/AppShell";
import { PartyListPage } from "@/components/parties/PartyTable";

export const Route = createFileRoute("/customers/")({
  component: CustomersPage,
});

function CustomersPage() {
  return (
    <AppShell title="العملاء" subtitle="إدارة العملاء وفواتير البيع.">
      <PartyListPage
        kind="customer"
        title="قائمة العملاء"
        description="ابحث، صنّف، أو أضف عميلاً جديداً. اضغط على السطر لعرض الملف الكامل."
      />
    </AppShell>
  );
}
