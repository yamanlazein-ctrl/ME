import { AppShell } from "@/components/layout/AppShell";
import { createFileRoute } from "@tanstack/react-router";
import { VoucherForm } from "@/components/vouchers/VoucherForm";
import { parseVoucherNewSearch } from "@/lib/voucherNewSearch";

export const Route = createFileRoute("/payments/new")({
  validateSearch: parseVoucherNewSearch,
  component: function PaymentsNewPage() {
    const { partyId, invoiceId, edit } = Route.useSearch();
    return (
      <AppShell
        title={edit ? "تعديل سند صرف" : "سند صرف جديد"}
        subtitle="تسجيل مبلغ مدفوع لمورد — نقداً أو تحويلاً أو شيكاً."
      >
        <VoucherForm
          kind="payment"
          initialPartyId={partyId}
          initialInvoiceId={invoiceId}
          editId={edit}
        />
      </AppShell>
    );
  },
});
