import { AppShell } from "@/components/layout/AppShell";
import { PageCard } from "@/components/layout/PageCard";
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
import { Checkbox } from "@/components/ui/checkbox";
import { NameCombobox } from "@/components/ui/name-combobox";
import { FormField } from "@/components/common/FormField";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState } from "react";
import { CURRENCIES, type Currency } from "@/presentation/hooks/useCurrency";
import type { VoucherMethod } from "@/domain/entities/Voucher";
import { Save, X, Lock } from "lucide-react";
import {
  useCreateExpense,
  useExpenseNamesList,
  useAddExpenseName,
} from "@/presentation/hooks/useExpenses";

export const Route = createFileRoute("/expenses/new")({ component: NewExpense });

function NewExpense() {
  const navigate = useNavigate();
  const { data: names = [] } = useExpenseNamesList();
  const addName = useAddExpenseName();
  const create = useCreateExpense();
  const [category, setCategory] = useState<string>("");
  const [description, setDescription] = useState("");
  const [amount, setAmount] = useState<number | "">("");
  const [currency, setCurrency] = useState<Currency>("SYP");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [method, setMethod] = useState<VoucherMethod>("cash");
  const [paidFromCashbox, setPaidFromCashbox] = useState(true);
  const [notesPrint, setNotesPrint] = useState("");
  const [notesInternal, setNotesInternal] = useState("");
  const [catError, setCatError] = useState<string | null>(null);
  const [amtError, setAmtError] = useState<string | null>(null);
  const [descError, setDescError] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  const save = () => {
    setErr(null);
    let valid = true;
    if (!category.trim()) {
      setCatError("اسم المصروف مطلوب.");
      valid = false;
    }
    const num = Number(amount);
    if (amount === "" || isNaN(num) || num <= 0) {
      setAmtError("أدخل مبلغاً صحيحاً أكبر من صفر.");
      valid = false;
    }
    if (!description.trim()) {
      setDescError("الوصف مطلوب.");
      valid = false;
    }
    if (!valid) return;
    create.mutate(
      {
        category,
        description,
        amount: Number(amount || 0),
        currency,
        date,
        method,
        paidFromCashbox,
        notesPrint: notesPrint || undefined,
        notesInternal: notesInternal || undefined,
      },
      {
        onSuccess: (res) => {
          if (res.ok) navigate({ to: "/expenses" });
          else
            setErr(
              (res.error as any)?.message ??
                (typeof res.error === "string" ? res.error : "فشل إنشاء المصروف"),
            );
        },
      },
    );
  };

  return (
    <AppShell title="مصروف جديد" subtitle="تسجيل تكلفة تشغيلية للشركة.">
      <PageCard
        title="بيانات المصروف"
        description="اكتب اسم المصروف مباشرة — لا توجد قائمة ثابتة. الأسماء الجديدة تُحفظ للاستخدام لاحقاً."
      >
        <div className="grid gap-3 md:grid-cols-3">
          <FormField label="اسم المصروف *" error={catError ?? undefined}>
            <NameCombobox
              value={category}
              onChange={(v) => {
                setCategory(v);
                setCatError(null);
              }}
              options={names}
              onAdd={(v) => addName.mutate(v)}
              placeholder="مثال: بنزين، شحن، صيانة…"
            />
          </FormField>
          <FormField label="التاريخ">
            <Input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="h-10"
            />
          </FormField>
          <FormField label="المبلغ *" error={amtError ?? undefined}>
            <Input
              type="number"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value === "" ? "" : Number(e.target.value));
                setAmtError(null);
              }}
              className="h-10"
            />
          </FormField>
          <FormField label="العملة">
            <Select value={currency} onValueChange={(v) => setCurrency(v as Currency)}>
              <SelectTrigger className="!h-10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {CURRENCIES.map((c) => (
                  <SelectItem key={c.code} value={c.code}>
                    {c.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </FormField>
          <FormField label="طريقة الدفع">
            <Select value={method} onValueChange={(v) => setMethod(v as VoucherMethod)}>
              <SelectTrigger className="!h-10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="cash">نقدي</SelectItem>
                <SelectItem value="transfer">تحويل بنكي</SelectItem>
              </SelectContent>
            </Select>
          </FormField>
          <div className="flex items-center gap-2 pt-6">
            <Checkbox
              id="cashbox"
              checked={paidFromCashbox}
              onCheckedChange={(v) => setPaidFromCashbox(!!v)}
            />
            <label htmlFor="cashbox" className="text-sm">
              مدفوع من الصندوق
            </label>
          </div>
          <div className="md:col-span-3">
            <FormField label="الوصف *" error={descError ?? undefined}>
              <Input
                value={description}
                onChange={(e) => {
                  setDescription(e.target.value);
                  setDescError(null);
                }}
                className="h-10"
              />
            </FormField>
          </div>
        </div>
      </PageCard>

      <PageCard title="الملاحظات">
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <Label className="text-[11px] text-muted-foreground">ملاحظات (تُطبع)</Label>
            <Textarea rows={3} value={notesPrint} onChange={(e) => setNotesPrint(e.target.value)} />
          </div>
          <div>
            <Label className="text-[11px] text-muted-foreground flex items-center gap-1">
              <Lock className="h-3 w-3" /> ملاحظات داخلية
            </Label>
            <Textarea
              rows={3}
              value={notesInternal}
              onChange={(e) => setNotesInternal(e.target.value)}
              className="bg-secondary/40"
            />
          </div>
        </div>
      </PageCard>

      {err && (
        <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm text-destructive">
          {err}
        </div>
      )}

      <div className="sticky bottom-0 -mx-6 border-t border-border bg-card/95 px-6 py-3 backdrop-blur">
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => history.back()}>
            <X className="h-4 w-4 ml-1" /> إلغاء
          </Button>
          <Button
            onClick={save}
            disabled={create.isPending}
            className="bg-primary text-primary-foreground"
          >
            <Save className="h-4 w-4 ml-1" /> {create.isPending ? "جارٍ الحفظ…" : "حفظ"}
          </Button>
        </div>
      </div>
    </AppShell>
  );
}
