import { AppShell } from "@/components/layout/AppShell";
import { createFileRoute } from "@tanstack/react-router";
import { VoucherForm } from "@/components/vouchers/VoucherForm";

export const Route = createFileRoute("/payments/new")({
  component: () => (
    <AppShell title="سند صرف جديد" subtitle="تسجيل مبلغ مدفوع لمورد — نقداً أو تحويلاً أو شيكاً.">
      <VoucherForm kind="payment" />
    </AppShell>
  ),
});
