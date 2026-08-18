import { createFileRoute, Link } from "@tanstack/react-router";
import { useState } from "react";
import { Receipt, FileInput, RotateCcw, Settings as SettingsIcon } from "lucide-react";
import { PageCard } from "@/components/layout/PageCard";
import { Checkbox } from "@/components/ui/checkbox";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useSettings, settings, updatePrinting } from "@/presentation/hooks/useSettings";
import { toast } from "sonner";
import {
  INVOICE_KIND_LABELS,
  INVOICE_KIND_ORDER,
  FIELD_LABELS,
  type FieldKey,
  type InvoiceKind,
  getAllVisibility,
  setFieldVisibility,
  resetKindVisibility,
} from "@/components/print/invoices/visibility";

export const Route = createFileRoute("/settings/invoice")({ component: InvoiceSettingsPage });

const KIND_ICONS: Record<InvoiceKind, React.ComponentType<{ className?: string }>> = {
  purchase: FileInput,
  sale: Receipt,
  return_in: RotateCcw,
  return_out: RotateCcw,
};

function InvoiceSettingsPage() {
  useSettings();
  const [p, setP] = usePrintingLocal();
  const [vis, setVis] = useState(() => getAllVisibility());

  const handleToggle = (kind: InvoiceKind, field: FieldKey, next: boolean) => {
    setFieldVisibility(kind, field, next);
    setVis(getAllVisibility());
  };

  const handleReset = (kind: InvoiceKind) => {
    resetKindVisibility(kind);
    setVis(getAllVisibility());
    toast.success(`تمت استعادة الإعدادات الافتراضية لـ ${INVOICE_KIND_LABELS[kind].label}`);
  };

  return (
    <div className="space-y-4">
      <PageCard
        title="إعدادات الفواتير"
        description="مركزية لإدارة كل ما يخص طباعة الفواتير والسندات. كل الحقول ظاهرة افتراضياً — يمكنك إخفاء ما لا تريد فقط، الإخفاء يؤثر على المستند المطبوع فقط ولا يحذف أي بيانات."
      >
        <div className="grid gap-3 md:grid-cols-3">
          <QuickLink
            title="معلومات الشركة"
            desc="الاسم، الشعار، السجل التجاري، الضريبي."
            to="/settings/company"
          />
          <QuickLink
            title="إعدادات الطباعة"
            desc="حجم الورق، الشعار، ملاحظة التذييل، عدد النسخ."
            to="/settings/printing"
          />
          <QuickLink
            title="طرق الدفع"
            desc="نقدي / تحويل بنكي / شيك / مخصصة."
            to="/settings/payment-methods"
          />
        </div>
      </PageCard>

      <PageCard
        title="إعدادات الطباعة العامة"
        description="تنطبق على كل أنواع الفواتير. الإعدادات التفصيلية لكل نوع في الأسفل."
      >
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <Label className="text-[11px] text-muted-foreground">حجم الورق</Label>
            <select
              value={p.paperSize}
              onChange={(e) => setP({ ...p, paperSize: e.target.value as typeof p.paperSize })}
              className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm"
            >
              <option value="A4">A4</option>
              <option value="A5">A5</option>
              <option value="80mm">80mm (حراري)</option>
            </select>
          </div>
          <div>
            <Label className="text-[11px] text-muted-foreground">عدد النسخ</Label>
            <Input
              type="number"
              value={p.copies}
              onChange={(e) => setP({ ...p, copies: Number(e.target.value) })}
            />
          </div>
          <div className="md:col-span-2 flex items-center gap-2">
            <Checkbox
              id="logo"
              checked={p.showLogo}
              onCheckedChange={(v) => setP({ ...p, showLogo: !!v })}
            />
            <label htmlFor="logo" className="text-sm">
              إظهار شعار الشركة
            </label>
          </div>
          <div className="md:col-span-2">
            <Label className="text-[11px] text-muted-foreground">ملاحظة أسفل الفاتورة</Label>
            <Input
              value={p.footerNote}
              onChange={(e) => setP({ ...p, footerNote: e.target.value })}
              placeholder="مثلاً: شكراً لتعاملكم معنا"
            />
          </div>
        </div>
        <div className="mt-4 flex justify-end">
          <Button
            onClick={() => {
              updatePrinting(p);
            }}
            className="bg-primary text-primary-foreground"
          >
            حفظ إعدادات الطباعة
          </Button>
        </div>
      </PageCard>

      {INVOICE_KIND_ORDER.map((kind) => {
        const Icon = KIND_ICONS[kind];
        const v = vis[kind];
        return (
          <PageCard
            key={kind}
            title={INVOICE_KIND_LABELS[kind].label}
            description="كل الحقول ظاهرة افتراضياً. يمكنك إخفاء ما لا تريده من المستند المطبوع فقط."
            actions={
              <Button
                size="sm"
                variant="outline"
                onClick={() => handleReset(kind)}
                className="gap-1"
              >
                <SettingsIcon className="h-3.5 w-3.5" /> إعادة الكل للظهور
              </Button>
            }
          >
            <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
              <Icon className="h-3.5 w-3.5" />
              <span>{INVOICE_KIND_LABELS[kind].short}</span>
            </div>
            <div className="grid gap-x-6 gap-y-2 md:grid-cols-2">
              {(Object.keys(FIELD_LABELS) as FieldKey[]).map((field) => (
                <div key={field} className="flex items-center gap-2">
                  <Checkbox
                    id={`${kind}-${field}`}
                    checked={v[field]}
                    onCheckedChange={(c) => handleToggle(kind, field, !!c)}
                  />
                  <label htmlFor={`${kind}-${field}`} className="text-sm text-foreground">
                    {FIELD_LABELS[field]}
                  </label>
                </div>
              ))}
            </div>
          </PageCard>
        );
      })}

      <div className="text-xs text-muted-foreground">
        ⚠ هذه الإعدادات تؤثر على المستند المطبوع فقط. لا يتم حذف أي حقل من قاعدة البيانات أو الـ
        API. كل حقل موجود في الفاتورة يظهر بشكل افتراضي — الإخفاء يدوي وحصري.
      </div>
    </div>
  );
}

function usePrintingLocal() {
  const [p, setP] = useState({ ...settings.printing });
  return [p, setP] as const;
}

function QuickLink({ title, desc, to }: { title: string; desc: string; to: string }) {
  return (
    <Link
      to={to}
      className="block rounded-lg border border-border p-3 transition hover:border-primary hover:bg-primary/5"
    >
      <div className="text-sm font-semibold text-foreground">{title}</div>
      <p className="mt-0.5 text-xs text-muted-foreground">{desc}</p>
    </Link>
  );
}
