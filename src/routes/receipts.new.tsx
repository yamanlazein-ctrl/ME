import { AppShell } from "@/components/layout/AppShell";
import { createFileRoute } from "@tanstack/react-router";
import { VoucherForm } from "@/components/vouchers/VoucherForm";

type Search = { partyId?: string; edit?: string };

export const Route = createFileRoute("/receipts/new")({
  validateSearch: (s: Record<string, unknown>): Search => ({
    partyId: typeof s.partyId === "string" ? s.partyId : undefined,
    edit: typeof s.edit === "string" ? s.edit : undefined,
  }),
  component: function ReceiptsNewPage() {
    const { partyId, edit } = Route.useSearch();
    return (
      <AppShell
        title={edit ? "تعديل سند قبض" : "سند قبض جديد"}
        subtitle="تسجيل مبلغ مستلم من عميل — نقداً أو تحويلاً أو شيكاً."
      >
        <VoucherForm kind="receipt" initialPartyId={partyId} editId={edit} />
      </AppShell>
    );
  },
});
