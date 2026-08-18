import { createFileRoute, Link } from "@tanstack/react-router";
import { Printer, FileText, Receipt, RotateCcw } from "lucide-react";
import { PageCard } from "@/components/layout/PageCard";
import { AppShell } from "@/components/layout/AppShell";

export const Route = createFileRoute("/print-center")({ component: PrintCenterPage });

const TEMPLATES = [
  {
    icon: FileText,
    title: "فاتورة دخول",
    to: "/invoices" as const,
    desc: "طباعة فاتورة الدخول بصيغة A4.",
  },
  {
    icon: Receipt,
    title: "فاتورة بيع",
    to: "/invoices" as const,
    desc: "طباعة فاتورة البيع بصيغة A4 أو حرارية.",
  },
  { icon: RotateCcw, title: "مرتجع", to: "/returns" as const, desc: "طباعة مستند مرتجع." },
];

function PrintCenterPage() {
  return (
    <AppShell title="مركز الطباعة" subtitle="نماذج الطباعة الجاهزة">
      <PageCard title="النماذج المتاحة" description="اختر مستنداً للطباعة أو اذهب لسجل الوحدة.">
        <div className="grid gap-3 md:grid-cols-3">
          {TEMPLATES.map((t) => (
            <Link
              key={t.title}
              to={t.to as string}
              className="flex flex-col items-start gap-2 rounded-xl border p-4 transition hover:border-primary hover:bg-primary/5"
            >
              <div className="rounded-lg bg-primary/10 p-2">
                <t.icon className="h-5 w-5 text-primary" />
              </div>
              <div className="text-sm font-semibold">{t.title}</div>
              <p className="text-xs text-muted-foreground">{t.desc}</p>
            </Link>
          ))}
        </div>
      </PageCard>
      <div className="h-3" />
      <PageCard title="إعدادات الطباعة" description="حجم الورق، الشعار، هامش التذييل، عدد النسخ.">
        <Link
          to="/settings/printing"
          className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-xs font-semibold text-primary-foreground"
        >
          <Printer className="h-4 w-4" /> فتح إعدادات الطباعة
        </Link>
      </PageCard>
    </AppShell>
  );
}
