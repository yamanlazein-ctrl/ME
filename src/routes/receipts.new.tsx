import { AppShell } from "@/components/layout/AppShell";
import { createFileRoute } from "@tanstack/react-router";
import { VoucherForm } from "@/components/vouchers/VoucherForm";
import { parseVoucherNewSearch } from "@/lib/voucherNewSearch";

export const Route = createFileRoute("/receipts/new")({
  validateSearch: parseVoucherNewSearch,
  component: function ReceiptsNewPage() {
    const { partyId, invoiceId, edit } = Route.useSearch();
    return (
      <AppShell
        title={edit ? "تعديل سند قبض" : "سند قبض جديد"}
        subtitle="تسجيل مبلغ مستلم من عميل — نقداً أو تحويلاً أو شيكاً."
      >
        <VoucherForm
          kind="receipt"
          initialPartyId={partyId}
          initialInvoiceId={invoiceId}
          editId={edit}
        />
      </AppShell>
    );
  },
});
