import { AppShell } from "@/components/layout/AppShell";
import { createFileRoute } from "@tanstack/react-router";
import { ReturnForm } from "@/components/returns/ReturnForm";

export const Route = createFileRoute("/returns/sale/new")({
  component: () => (
    <AppShell
      title="مرتجع بيع جديد"
      subtitle="استرجاع بضاعة من العميل — يعيدها للمخزون ويقلل المستحق على العميل."
    >
      <ReturnForm kind="sale" />
    </AppShell>
  ),
});
