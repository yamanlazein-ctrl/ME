import { AppShell } from "@/components/layout/AppShell";
import { createFileRoute } from "@tanstack/react-router";
import { VoucherForm } from "@/components/vouchers/VoucherForm";

type Search = { partyId?: string; edit?: string };

export const Route = createFileRoute("/payments/new")({
  validateSearch: (s: Record<string, unknown>): Search => ({
    partyId: typeof s.partyId === "string" ? s.partyId : undefined,
    edit: typeof s.edit === "string" ? s.edit : undefined,
  }),
  component: function PaymentsNewPage() {
    const { partyId, edit } = Route.useSearch();
    return (
      <AppShell
        title={edit ? "تعديل سند صرف" : "سند صرف جديد"}
        subtitle="تسجيل مبلغ مدفوع لمورد — نقداً أو تحويلاً أو شيكاً."
      >
        <VoucherForm kind="payment" initialPartyId={partyId} editId={edit} />
      </AppShell>
    );
  },
});
