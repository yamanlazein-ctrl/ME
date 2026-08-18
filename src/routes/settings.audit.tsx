import { createFileRoute } from "@tanstack/react-router";
import { PageCard } from "@/components/layout/PageCard";
import { Check, X } from "lucide-react";

export const Route = createFileRoute("/settings/audit")({ component: AuditPage });

const DONE = [
  "لوحة التحكم",
  "العملاء",
  "الموردون",
  "المخزون",
  "فاتورة الدخول",
  "فاتورة البيع",
  "المرتجعات",
  "المصاريف",
  "الصندوق",
  "دفتر الحركات",
  "سندات القبض",
  "سندات الصرف",
  "الإعدادات (هيكل)",
];

const MISSING = [
  "المستخدمون والصلاحيات (واجهة فقط)",
  "سجل النشاط (واجهة فقط)",
  "النسخ الاحتياطي والاستعادة (واجهة فقط)",
  "مركز الطباعة",
  "التقارير",
];

function AuditPage() {
  return (
    <PageCard
      title="حالة النظام"
      description="مراجعة الوحدات المكتملة والوحدات المتبقية حسب المواصفات."
    >
      <div className="grid gap-4 md:grid-cols-2">
        <div>
          <div className="mb-2 text-xs font-semibold text-success">مكتمل</div>
          <ul className="space-y-1 text-sm">
            {DONE.map((d) => (
              <li key={d} className="flex items-center gap-2">
                <Check className="h-4 w-4 text-success" /> {d}
              </li>
            ))}
          </ul>
        </div>
        <div>
          <div className="mb-2 text-xs font-semibold text-destructive">متبقّي</div>
          <ul className="space-y-1 text-sm">
            {MISSING.map((d) => (
              <li key={d} className="flex items-center gap-2">
                <X className="h-4 w-4 text-destructive" /> {d}
              </li>
            ))}
          </ul>
        </div>
      </div>
    </PageCard>
  );
}
