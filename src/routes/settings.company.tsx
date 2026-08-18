import { createFileRoute } from "@tanstack/react-router";
import { PageCard } from "@/components/layout/PageCard";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { useSettings, settings, updateCompany } from "@/presentation/hooks/useSettings";
import { useState } from "react";

export const Route = createFileRoute("/settings/company")({ component: CompanyPage });

function CompanyPage() {
  useSettings();
  const [c, setC] = useState({ ...settings.company });
  return (
    <PageCard
      title="معلومات الشركة"
      description="اسم الشركة والعنوان وبيانات التواصل — تظهر في الفواتير والطباعة."
    >
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="اسم الشركة">
          <Input value={c.name} onChange={(e) => setC({ ...c, name: e.target.value })} />
        </Field>
        <Field label="السجل التجاري">
          <Input
            value={c.commercialReg}
            onChange={(e) => setC({ ...c, commercialReg: e.target.value })}
          />
        </Field>
        <Field label="الرقم الضريبي">
          <Input value={c.taxNumber} onChange={(e) => setC({ ...c, taxNumber: e.target.value })} />
        </Field>
        <Field label="الهاتف">
          <Input value={c.phone} onChange={(e) => setC({ ...c, phone: e.target.value })} />
        </Field>
        <Field label="البريد الإلكتروني">
          <Input value={c.email} onChange={(e) => setC({ ...c, email: e.target.value })} />
        </Field>
        <Field label="المدينة">
          <Input value={c.city} onChange={(e) => setC({ ...c, city: e.target.value })} />
        </Field>
        <div className="md:col-span-2">
          <Field label="العنوان">
            <Input value={c.address} onChange={(e) => setC({ ...c, address: e.target.value })} />
          </Field>
        </div>
      </div>
      <div className="mt-4 flex justify-end">
        <Button onClick={() => updateCompany(c)} className="bg-primary text-primary-foreground">
          حفظ
        </Button>
      </div>
    </PageCard>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <Label className="mb-1 block text-[11px] font-semibold text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}
