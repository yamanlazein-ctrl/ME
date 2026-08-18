import { AppShell } from "@/components/layout/AppShell";
import { createFileRoute } from "@tanstack/react-router";
import { ReturnForm } from "@/components/returns/ReturnForm";

export const Route = createFileRoute("/returns/entry/new")({
  component: () => (
    <AppShell
      title="مرتجع دخول جديد"
      subtitle="إرجاع بضاعة إلى المورد — يخصم من المخزون ويقلل المستحق للمورد."
    >
      <ReturnForm kind="entry" />
    </AppShell>
  ),
});
