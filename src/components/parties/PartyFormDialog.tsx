import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Currency } from "@/domain/types";
import type { PartyStatus, PaymentMethod, PaymentTerms } from "@/domain/entities/Party";

export type PartyKind = "supplier" | "customer";

export type SimpleParty = {
  id: string;
  code?: string;
  name: string;
  companyName?: string | null;
  commercialReg?: string | null;
  category?: string | null;
  salesRep?: string | null;
  phone?: string | null;
  mobile?: string | null;
  whatsapp?: string | null;
  altPhone?: string | null;
  email?: string | null;
  website?: string | null;
  address?: string | null;
  city?: string | null;
  country?: string | null;
  taxNumber?: string | null;
  openingBalance?: number;
  creditLimit?: number;
  currency?: Currency;
  paymentTerms?: PaymentTerms;
  paymentMethod?: PaymentMethod;
  defaultDiscount?: number;
  vat?: number;
  notes?: string | null;
  status?: PartyStatus;
};

const LABELS = {
  supplier: {
    entity: "المورد",
    addTitle: "إضافة مورد جديد",
    editTitle: "تعديل بيانات المورد",
    nameLabel: "اسم المورد",
  },
  customer: {
    entity: "العميل",
    addTitle: "إضافة عميل جديد",
    editTitle: "تعديل بيانات العميل",
    nameLabel: "اسم العميل",
  },
} as const;

const TABS = [
  { id: "basic", label: "بيانات أساسية" },
  { id: "contact", label: "اتصال" },
  { id: "address", label: "عنوان" },
  { id: "financial", label: "مالي" },
] as const;
type TabId = (typeof TABS)[number]["id"];

type Draft = {
  code: string;
  name: string;
  companyName: string;
  commercialReg: string;
  category: string;
  salesRep: string;
  taxNumber: string;
  status: PartyStatus;
  phone: string;
  mobile: string;
  whatsapp: string;
  email: string;
  website: string;
  address: string;
  city: string;
  country: string;
  openingBalance: string;
  creditLimit: string;
  currency: Currency;
  paymentTerms: PaymentTerms;
  paymentMethod: PaymentMethod;
  defaultDiscount: string;
  vat: string;
  notes: string;
};

const emptyDraft = (): Draft => ({
  code: "",
  name: "",
  companyName: "",
  commercialReg: "",
  category: "",
  salesRep: "",
  taxNumber: "",
  status: "active",
  phone: "",
  mobile: "",
  whatsapp: "",
  email: "",
  website: "",
  address: "",
  city: "",
  country: "سوريا",
  openingBalance: "",
  creditLimit: "",
  currency: "SYP",
  paymentTerms: "cash",
  paymentMethod: "cash",
  defaultDiscount: "",
  vat: "",
  notes: "",
});

const fromParty = (p: SimpleParty): Draft => ({
  code: p.code ?? "",
  name: p.name ?? "",
  companyName: p.companyName ?? "",
  commercialReg: p.commercialReg ?? "",
  category: p.category ?? "",
  salesRep: p.salesRep ?? "",
  taxNumber: p.taxNumber ?? "",
  status: p.status ?? "active",
  phone: p.phone ?? "",
  mobile: p.mobile ?? "",
  whatsapp: p.whatsapp ?? "",
  email: p.email ?? "",
  website: p.website ?? "",
  address: p.address ?? "",
  city: p.city ?? "",
  country: p.country ?? "سوريا",
  openingBalance: p.openingBalance != null ? String(p.openingBalance) : "",
  creditLimit: p.creditLimit != null ? String(p.creditLimit) : "",
  currency: p.currency ?? "SYP",
  paymentTerms: p.paymentTerms ?? "cash",
  paymentMethod: p.paymentMethod ?? "cash",
  defaultDiscount: p.defaultDiscount != null ? String(p.defaultDiscount) : "",
  vat: p.vat != null ? String(p.vat) : "",
  notes: p.notes ?? "",
});

const toPatch = (d: Draft, kind: PartyKind): Omit<SimpleParty, "id"> => ({
  code: d.code.trim() || undefined,
  name: d.name.trim(),
  companyName: d.companyName.trim() || undefined,
  commercialReg: d.commercialReg.trim() || undefined,
  category: kind === "supplier" ? d.category.trim() || undefined : undefined,
  salesRep: kind === "customer" ? d.salesRep.trim() || undefined : undefined,
  taxNumber: d.taxNumber.trim() || undefined,
  status: d.status,
  phone: d.phone.trim() || undefined,
  mobile: d.mobile.trim() || undefined,
  whatsapp: d.whatsapp.trim() || undefined,
  email: d.email.trim() || undefined,
  website: d.website.trim() || undefined,
  address: d.address.trim() || undefined,
  city: d.city.trim() || undefined,
  country: d.country.trim() || undefined,
  openingBalance: d.openingBalance === "" ? 0 : Number(d.openingBalance) || 0,
  creditLimit: d.creditLimit === "" ? 0 : Number(d.creditLimit) || 0,
  currency: d.currency,
  paymentTerms: d.paymentTerms,
  paymentMethod: d.paymentMethod,
  defaultDiscount: d.defaultDiscount === "" ? 0 : Number(d.defaultDiscount) || 0,
  vat: d.vat === "" ? 0 : Number(d.vat) || 0,
  notes: d.notes.trim() || undefined,
});

export function PartyFormDialog({
  kind,
  open,
  editing,
  onClose,
  onSubmit,
}: {
  kind: PartyKind;
  open: boolean;
  editing?: SimpleParty;
  onClose: () => void;
  onSubmit: (patch: Omit<SimpleParty, "id">) => void;
}) {
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>("basic");

  useEffect(() => {
    if (open) {
      setDraft(editing ? fromParty(editing) : emptyDraft());
      setErr(null);
      setTab("basic");
    }
  }, [open, editing]);

  const patch = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const submit = () => {
    if (!draft.name.trim()) {
      setErr(`${LABELS[kind].nameLabel} مطلوب.`);
      setTab("basic");
      return;
    }
    onSubmit(toPatch(draft, kind));
  };

  const L = LABELS[kind];

  return (
    <Dialog open={open} onOpenChange={(o) => !o && onClose()}>
      <DialogContent dir="rtl" className="max-h-[90vh] max-w-[900px] gap-0 overflow-hidden p-0">
        <DialogHeader className="border-b border-border px-6 py-4">
          <DialogTitle className="text-base font-bold">
            {editing ? L.editTitle : L.addTitle}
          </DialogTitle>
          <DialogDescription className="text-xs text-muted-foreground">
            سجل حساب محاسبي كامل — أدخل جميع الحقول لضمان دقة كشف الحساب.
          </DialogDescription>
        </DialogHeader>

        {/* Tabs strip */}
        <div className="flex items-center gap-1 border-b border-border bg-secondary/30 px-3 py-2">
          {TABS.map((t) => (
            <button
              key={t.id}
              type="button"
              onClick={() => setTab(t.id)}
              className={`h-8 rounded-md px-3 text-xs font-semibold transition ${
                tab === t.id
                  ? "bg-primary/15 text-primary"
                  : "text-muted-foreground hover:bg-secondary hover:text-foreground"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="max-h-[calc(90vh-13rem)] space-y-4 overflow-y-auto px-6 py-5">
          {tab === "basic" && (
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="الكود">
                <Input
                  className="h-10 tabular-nums"
                  value={draft.code}
                  placeholder="يُنشأ تلقائياً"
                  onChange={(e) => patch("code", e.target.value)}
                />
              </Field>
              <Field label="الحالة">
                <Select
                  value={draft.status}
                  onValueChange={(v) => patch("status", v as PartyStatus)}
                >
                  <SelectTrigger className="!h-10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="active">نشط</SelectItem>
                    <SelectItem value="inactive">موقوف</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field label={`${L.nameLabel} *`}>
                <Input
                  className="h-10"
                  value={draft.name}
                  onChange={(e) => patch("name", e.target.value)}
                />
              </Field>
              <Field label="اسم الشركة">
                <Input
                  className="h-10"
                  value={draft.companyName}
                  onChange={(e) => patch("companyName", e.target.value)}
                />
              </Field>
              <Field label="السجل التجاري">
                <Input
                  className="h-10 tabular-nums"
                  value={draft.commercialReg}
                  onChange={(e) => patch("commercialReg", e.target.value)}
                />
              </Field>
              <Field label="الرقم الضريبي">
                <Input
                  className="h-10 tabular-nums"
                  value={draft.taxNumber}
                  onChange={(e) => patch("taxNumber", e.target.value)}
                />
              </Field>
              {kind === "supplier" ? (
                <Field label="تصنيف المورد" className="md:col-span-2">
                  <Input
                    className="h-10"
                    value={draft.category}
                    placeholder="مصنع نسيج، مستورد، تاجر..."
                    onChange={(e) => patch("category", e.target.value)}
                  />
                </Field>
              ) : (
                <Field label="مندوب المبيعات" className="md:col-span-2">
                  <Input
                    className="h-10"
                    value={draft.salesRep}
                    onChange={(e) => patch("salesRep", e.target.value)}
                  />
                </Field>
              )}
              <Field label="ملاحظات" className="md:col-span-2">
                <Textarea
                  rows={2}
                  className="resize-none"
                  value={draft.notes}
                  onChange={(e) => patch("notes", e.target.value)}
                />
              </Field>
            </div>
          )}

          {tab === "contact" && (
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="الهاتف">
                <Input
                  className="h-10 tabular-nums"
                  value={draft.phone}
                  onChange={(e) => patch("phone", e.target.value)}
                />
              </Field>
              <Field label="الجوال">
                <Input
                  className="h-10 tabular-nums"
                  value={draft.mobile}
                  onChange={(e) => patch("mobile", e.target.value)}
                />
              </Field>
              <Field label="واتساب">
                <Input
                  className="h-10 tabular-nums"
                  value={draft.whatsapp}
                  onChange={(e) => patch("whatsapp", e.target.value)}
                />
              </Field>
              <Field label="البريد الإلكتروني">
                <Input
                  className="h-10"
                  value={draft.email}
                  onChange={(e) => patch("email", e.target.value)}
                />
              </Field>
              <Field label="الموقع الإلكتروني" className="md:col-span-2">
                <Input
                  className="h-10"
                  value={draft.website}
                  onChange={(e) => patch("website", e.target.value)}
                />
              </Field>
            </div>
          )}

          {tab === "address" && (
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="الدولة">
                <Input
                  className="h-10"
                  value={draft.country}
                  onChange={(e) => patch("country", e.target.value)}
                />
              </Field>
              <Field label="المدينة">
                <Input
                  className="h-10"
                  value={draft.city}
                  onChange={(e) => patch("city", e.target.value)}
                />
              </Field>
              <Field label="العنوان" className="md:col-span-2">
                <Textarea
                  rows={2}
                  className="resize-none"
                  value={draft.address}
                  onChange={(e) => patch("address", e.target.value)}
                />
              </Field>
            </div>
          )}

          {tab === "financial" && (
            <div className="grid gap-3 md:grid-cols-2">
              <Field label="الرصيد الافتتاحي">
                <Input
                  type="number"
                  className="h-10 tabular-nums"
                  value={draft.openingBalance}
                  onChange={(e) => patch("openingBalance", e.target.value)}
                />
              </Field>
              <Field label="حد الائتمان">
                <Input
                  type="number"
                  className="h-10 tabular-nums"
                  value={draft.creditLimit}
                  onChange={(e) => patch("creditLimit", e.target.value)}
                />
              </Field>
              <Field label="العملة الافتراضية">
                <Select
                  value={draft.currency}
                  onValueChange={(v) => patch("currency", v as Currency)}
                >
                  <SelectTrigger className="!h-10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="SYP">ل.س</SelectItem>
                    <SelectItem value="USD">$ دولار</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field label="شروط الدفع">
                <Select
                  value={draft.paymentTerms}
                  onValueChange={(v) => patch("paymentTerms", v as PaymentTerms)}
                >
                  <SelectTrigger className="!h-10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cash">نقدي</SelectItem>
                    <SelectItem value="net15">15 يوم</SelectItem>
                    <SelectItem value="net30">30 يوم</SelectItem>
                    <SelectItem value="net60">60 يوم</SelectItem>
                    <SelectItem value="net90">90 يوم</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field label="طريقة الدفع المفضلة">
                <Select
                  value={draft.paymentMethod}
                  onValueChange={(v) => patch("paymentMethod", v as PaymentMethod)}
                >
                  <SelectTrigger className="!h-10">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cash">نقدي</SelectItem>
                    <SelectItem value="transfer">حوالة بنكية</SelectItem>
                    <SelectItem value="check">شيك</SelectItem>
                    <SelectItem value="card">بطاقة</SelectItem>
                  </SelectContent>
                </Select>
              </Field>
              <Field label="خصم افتراضي (%)">
                <Input
                  type="number"
                  className="h-10 tabular-nums"
                  value={draft.defaultDiscount}
                  onChange={(e) => patch("defaultDiscount", e.target.value)}
                />
              </Field>
              <Field label="ضريبة القيمة المضافة (%)">
                <Input
                  type="number"
                  className="h-10 tabular-nums"
                  value={draft.vat}
                  onChange={(e) => patch("vat", e.target.value)}
                />
              </Field>
            </div>
          )}

          {err && (
            <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {err}
            </div>
          )}
        </div>

        <DialogFooter className="sticky bottom-0 flex-row-reverse gap-2 border-t border-border bg-card/95 px-6 py-3 backdrop-blur">
          <Button
            onClick={submit}
            className="h-10 bg-primary text-primary-foreground hover:bg-primary/90"
          >
            حفظ
          </Button>
          <Button variant="ghost" onClick={onClose} className="h-10">
            إلغاء
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function Field({
  label,
  children,
  className = "",
}: {
  label: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={className}>
      <Label className="mb-1 block text-[11px] font-semibold text-muted-foreground">{label}</Label>
      {children}
    </div>
  );
}
