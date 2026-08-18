import { createFileRoute } from "@tanstack/react-router";
import { PageCard } from "@/components/layout/PageCard";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { useSettings, settings, updatePrinting } from "@/presentation/hooks/useSettings";
import { useState } from "react";

export const Route = createFileRoute("/settings/printing")({ component: PrintingPage });

function PrintingPage() {
  useSettings();
  const [p, setP] = useState({ ...settings.printing });
  return (
    <PageCard title="الطباعة" description="إعدادات طباعة الفواتير والسندات.">
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
          />
        </div>
      </div>
      <div className="mt-4 flex justify-end">
        <Button onClick={() => updatePrinting(p)} className="bg-primary text-primary-foreground">
          حفظ
        </Button>
      </div>
    </PageCard>
  );
}
