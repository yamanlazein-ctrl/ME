import { createFileRoute } from "@tanstack/react-router";
import { PageCard } from "@/components/layout/PageCard";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/common/FormField";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useSettingsDraft, updatePrinting } from "@/presentation/hooks/useSettings";

export const Route = createFileRoute("/settings/printing")({ component: PrintingPage });

function PrintingPage() {
  // F-018: seeded from the server's data, not the built-in defaults; save waits for it.
  const [p, setP, ready] = useSettingsDraft("printing");
  return (
    <PageCard title="الطباعة" description="إعدادات طباعة الفواتير والسندات.">
      <div className="grid gap-3 md:grid-cols-2">
        <FormField
          labelClassName="text-[11px] text-muted-foreground"
          label="حجم الورق"
          htmlFor="print-paper"
        >
          <select
            id="print-paper"
            value={p.paperSize}
            onChange={(e) => setP({ ...p, paperSize: e.target.value as typeof p.paperSize })}
            className="h-10 w-full rounded-md border border-border bg-background px-3 text-sm"
          >
            <option value="A4">A4</option>
            <option value="A5">A5</option>
            <option value="80mm">80mm (حراري)</option>
          </select>
        </FormField>
        <FormField labelClassName="text-[11px] text-muted-foreground" label="عدد النسخ">
          <Input
            type="number"
            value={p.copies}
            onChange={(e) => setP({ ...p, copies: Number(e.target.value) })}
          />
        </FormField>
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
        <FormField
          className="md:col-span-2"
          labelClassName="text-[11px] text-muted-foreground"
          label="ملاحظة أسفل الفاتورة"
        >
          <Input
            value={p.footerNote}
            onChange={(e) => setP({ ...p, footerNote: e.target.value })}
          />
        </FormField>
      </div>
      <div className="mt-4 flex justify-end">
        <Button
          onClick={() => updatePrinting(p)}
          disabled={!ready}
          className="bg-primary text-primary-foreground"
        >
          حفظ
        </Button>
      </div>
    </PageCard>
  );
}
