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
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import type { PartyOpeningInput } from "@erp/shared";
import { localToday } from "@/lib/localDate";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import type { Currency } from "@/domain/types";
import { PARTY_EMAIL_INPUT_PROPS, partyEmailError } from "@/lib/partyEmail";
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
  openingDate?: string | null;
  openingNote?: string | null;
  openingCurrency?: Currency | null;
  /** Edit only, and only when the opening balance changed → PUT …/:id/opening. */
  opening?: PartyOpeningInput;
  creditLimit?: number;
  currency?: Currency;
  paymentTerms?: PaymentTerms;
  paymentMethod?: PaymentMethod;
  defaultDiscount?: number;
  vat?: number;
  notes?: string | null;
  status?: PartyStatus;
};

type OpeningDirection = PartyOpeningInput["direction"];
type OpeningCurrency = PartyOpeningInput["currency"];

/** Positive SoT = "they owe us" for a customer, "we owe them" for a supplier. */
const positiveDirection = (kind: PartyKind): OpeningDirection =>
  kind === "supplier" ? "we_owe_them" : "they_owe_us";

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
  openingAmount: string;
  openingDirection: OpeningDirection;
  openingCurrency: OpeningCurrency;
  openingDate: string;
  openingNote: string;
  creditLimit: string;
  currency: Currency;
  paymentTerms: PaymentTerms;
  paymentMethod: PaymentMethod;
  defaultDiscount: string;
  vat: string;
  notes: string;
};

const emptyDraft = (kind: PartyKind): Draft => ({
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
  openingAmount: "",
  openingDirection: positiveDirection(kind),
  openingCurrency: "SYP",
  openingDate: "",
  openingNote: "",
  creditLimit: "",
  currency: "SYP",
  paymentTerms: "cash",
  paymentMethod: "cash",
  defaultDiscount: "",
  vat: "",
  notes: "",
});

export const fromParty = (p: SimpleParty, kind: PartyKind): Draft => ({
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
  openingAmount: p.openingBalance ? String(Math.abs(p.openingBalance)) : "",
  openingDirection:
    (p.openingBalance ?? 0) < 0
      ? positiveDirection(kind) === "they_owe_us"
        ? "we_owe_them"
        : "they_owe_us"
      : positiveDirection(kind),
  openingCurrency: (p.openingCurrency ?? p.currency) === "USD" ? "USD" : "SYP",
  openingDate: p.openingDate ?? "",
  openingNote: p.openingNote ?? "",
  creditLimit: p.creditLimit != null ? String(p.creditLimit) : "",
  currency: p.currency ?? "SYP",
  paymentTerms: p.paymentTerms ?? "cash",
  paymentMethod: p.paymentMethod ?? "cash",
  defaultDiscount: p.defaultDiscount != null ? String(p.defaultDiscount) : "",
  vat:
    p.vat != null && Number(p.vat) !== 0
      ? String(Number(p.vat) > 1 ? Number(p.vat) : Math.round(Number(p.vat) * 10000) / 100)
      : "",
  notes: p.notes ?? "",
});

const openingAmountOf = (d: Draft): number =>
  d.openingAmount === "" ? 0 : Number(d.openingAmount);

/** True when the opening section differs from what the party has now. */
const openingChanged = (d: Draft, before: Draft): boolean => {
  const a = openingAmountOf(d);
  const b = openingAmountOf(before);
  if (a === 0 && b === 0) return false;
  return (
    a !== b ||
    d.openingDirection !== before.openingDirection ||
    d.openingCurrency !== before.openingCurrency ||
    (d.openingDate || "") !== (before.openingDate || "") ||
    d.openingNote.trim() !== before.openingNote.trim()
  );
};

export const toPatch = (
  d: Draft,
  kind: PartyKind,
  editing: SimpleParty | undefined,
): Omit<SimpleParty, "id"> => {
  const vatPct = d.vat === "" ? 0 : Number(d.vat) || 0;
  // UI is always percent (16); DB stores fraction (0.16) in decimal(5,4).
  const vatFraction = Math.min(1, Math.max(0, vatPct / 100));
  const patch: Omit<SimpleParty, "id"> = {
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
    creditLimit: d.creditLimit === "" ? 0 : Number(d.creditLimit) || 0,
    currency: d.currency,
    paymentTerms: d.paymentTerms,
    paymentMethod: d.paymentMethod,
    defaultDiscount: d.defaultDiscount === "" ? 0 : Number(d.defaultDiscount) || 0,
    vat: vatFraction,
    notes: d.notes.trim() || undefined,
  };
  // Create: the opening journal is written with the party. Edit: a plain field
  // update refuses opening fields, so a changed balance travels as `opening`
  // (PUT …/:id/opening — old journal cancelled, new one posted).
  const amount = openingAmountOf(d);
  if (!editing) {
    patch.openingBalance = d.openingDirection === positiveDirection(kind) ? amount : -amount;
    if (amount !== 0) {
      patch.openingCurrency = d.openingCurrency;
      patch.openingDate = d.openingDate || undefined;
      patch.openingNote = d.openingNote.trim() || undefined;
    }
  } else if (openingChanged(d, fromParty(editing, kind))) {
    patch.opening = {
      amount,
      direction: d.openingDirection,
      currency: d.openingCurrency,
      date: d.openingDate || localToday(),
      note: d.openingNote.trim() || null,
    };
  }
  return patch;
};

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
  const [draft, setDraft] = useState<Draft>(() => emptyDraft(kind));
  const [err, setErr] = useState<string | null>(null);
  const [tab, setTab] = useState<TabId>("basic");
  const [confirmOpening, setConfirmOpening] = useState(false);

  useEffect(() => {
    if (open) {
      setDraft(editing ? fromParty(editing, kind) : emptyDraft(kind));
      setConfirmOpening(false);
      setErr(null);
      setTab("basic");
    }
  }, [open, editing, kind]);

  const patch = <K extends keyof Draft>(k: K, v: Draft[K]) => setDraft((d) => ({ ...d, [k]: v }));

  const submit = (confirmed = false) => {
    if (!draft.name.trim()) {
      setErr(`${LABELS[kind].nameLabel} مطلوب.`);
      setTab("basic");
      return;
    }
    const emailErr = partyEmailError(draft.email);
    if (emailErr) {
      setErr(emailErr);
      setTab("contact");
      return;
    }
    const vatPct = draft.vat === "" ? 0 : Number(draft.vat);
    if (draft.vat !== "" && (!Number.isFinite(vatPct) || vatPct < 0 || vatPct > 100)) {
      setErr("نسبة الضريبة يجب أن تكون بين 0 و 100.");
      setTab("financial");
      return;
    }
    const amount = openingAmountOf(draft);
    if (!Number.isFinite(amount) || amount < 0 || Math.round(amount * 100) !== amount * 100) {
      setErr("مبلغ الرصيد السابق يجب أن يكون رقماً موجباً بخانتين عشريتين على الأكثر.");
      setTab("financial");
      return;
    }
    setErr(null);
    const out = toPatch(draft, kind, editing);
    // Re-posting the opening journal is visible in the statement — confirm first.
    if (out.opening && !confirmed) {
      setConfirmOpening(true);
      return;
    }
    setConfirmOpening(false);
    onSubmit(out);
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
                  {...PARTY_EMAIL_INPUT_PROPS}
                  className="h-10"
                  value={draft.email}
                  onChange={(e) => {
                    patch("email", e.target.value);
                    setErr(null);
                  }}
                  aria-invalid={Boolean(partyEmailError(draft.email))}
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
              <div className="grid gap-3 rounded-lg border border-border p-3 md:col-span-2 md:grid-cols-3">
                <div className="text-xs font-bold md:col-span-3">الرصيد السابق</div>
                <Field label="المبلغ">
                  <Input
                    type="number"
                    min={0}
                    step="0.01"
                    className="h-10 tabular-nums"
                    value={draft.openingAmount}
                    onChange={(e) => patch("openingAmount", e.target.value)}
                  />
                </Field>
                <Field label="النوع">
                  <Select
                    value={draft.openingDirection}
                    onValueChange={(v) => patch("openingDirection", v as OpeningDirection)}
                  >
                    <SelectTrigger className="!h-10">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="they_owe_us">لنا / مدين</SelectItem>
                      <SelectItem value="we_owe_them">له / دائن</SelectItem>
                    </SelectContent>
                  </Select>
                </Field>
                <Field label="العملة">
                  <Select
                    value={draft.openingCurrency}
                    onValueChange={(v) => patch("openingCurrency", v as OpeningCurrency)}
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
                <Field label="التاريخ (فارغ = اليوم)">
                  <Input
                    type="date"
                    className="h-10"
                    value={draft.openingDate}
                    onChange={(e) => patch("openingDate", e.target.value)}
                  />
                </Field>
                <Field label="ملاحظات" className="md:col-span-2">
                  <Input
                    className="h-10"
                    maxLength={500}
                    value={draft.openingNote}
                    onChange={(e) => patch("openingNote", e.target.value)}
                  />
                </Field>
              </div>
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
              <Field label="خصم افتراضي (مبلغ)">
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
                  min={0}
                  max={100}
                  step="0.01"
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
            onClick={() => submit()}
            className="h-10 bg-primary text-primary-foreground hover:bg-primary/90"
          >
            حفظ
          </Button>
          <Button variant="ghost" onClick={onClose} className="h-10">
            إلغاء
          </Button>
        </DialogFooter>
      </DialogContent>
      <AlertDialog open={confirmOpening} onOpenChange={setConfirmOpening}>
        <AlertDialogContent dir="rtl">
          <AlertDialogHeader>
            <AlertDialogTitle>تعديل الرصيد السابق</AlertDialogTitle>
            <AlertDialogDescription>
              سيُلغى القيد السابق ويُسجَّل قيد جديد، ويبقى القديم ظاهراً ملغى في كشف الحساب.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>إلغاء</AlertDialogCancel>
            <AlertDialogAction onClick={() => submit(true)}>متابعة</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
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
