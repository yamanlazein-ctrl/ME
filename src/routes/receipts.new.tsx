import { AppShell } from "@/components/layout/AppShell";
import { createFileRoute } from "@tanstack/react-router";
import { VoucherForm } from "@/components/vouchers/VoucherForm";

export const Route = createFileRoute("/receipts/new")({
  component: () => (
    <AppShell title="سند قبض جديد" subtitle="تسجيل مبلغ مستلم من عميل — نقداً أو تحويلاً أو شيكاً.">
      <VoucherForm kind="receipt" />
    </AppShell>
  ),
});
