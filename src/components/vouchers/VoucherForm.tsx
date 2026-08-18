import { useState, useMemo } from "react";
import { useNavigate } from "@tanstack/react-router";
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
import { FormField } from "@/components/common/FormField";
import { PartyCombobox } from "@/components/vouchers/PartyCombobox";
import { PartyFormDialog } from "@/components/parties/PartyFormDialog";
import { addCustomer, addSupplier, type Currency } from "@/presentation/hooks/useParties";
import { CURRENCIES, formatAmount } from "@/presentation/hooks/useCurrency";
import {
  useCreateReceiptVoucher,
  useCreatePaymentVoucher,
  type VoucherKind,
  type VoucherMethod,
} from "@/presentation/hooks/useVouchers";
import { useInvoicesList } from "@/presentation/hooks/useInvoices";
import { useVouchersList } from "@/presentation/hooks/useVouchers";
import { invoiceTotal } from "@/core/calculations/invoiceCalc";
import { Save, X, Lock } from "lucide-react";

export function VoucherForm({ kind }: { kind: VoucherKind }) {
  const navigate = useNavigate();
  const createReceipt = useCreateReceiptVoucher();
  const createPayment = useCreatePaymentVoucher();
  const isReceipt = kind === "receipt";
  const [partyId, setPartyId] = useState("");
  const [invoiceId, setInvoiceId] = useState<string>("");
  const [amount, setAmount] = useState<number | "">("");
  const [currency, setCurrency] = useState<Currency>("SYP");
  const [method, setMethod] = useState<VoucherMethod>("cash");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [notesPrint, setNotesPrint] = useState("");
  const [notesInternal, setNotesInternal] = useState("");
  const [partyError, setPartyError] = useState<string | null>(null);
  const [amountError, setAmountError] = useState<string | null>(null);
  const [addPartyOpen, setAddPartyOpen] = useState(false);

  const { data: invoicesData } = useInvoicesList();
  const allInvoices = invoicesData?.data ?? [];
  const { data: vouchersData } = useVouchersList();
  const allVouchers = vouchersData?.data ?? [];

  const invoiceOptions = useMemo(() => {
    if (!partyId) return [];
    const wantedType = isReceipt ? "sale" : "entry";
    // Guard against duplicate invoice rows in the fetched data: dedupe by id so
    // we never render two <SelectItem> with the same value/key (which would make
    // the Radix dropdown appear to draw the same list twice).
    const seen = new Set<string>();
    return allInvoices
      .filter((i) => i.type === wantedType && i.status !== "cancelled" && i.partyId === partyId)
      .map((i) => {
        const paidOfInvoice = allVouchers
          .filter((v) => v.status === "active" && v.invoiceId === i.id)
          .reduce((s, v) => s + v.amount, 0);
        return {
          ...i,
          remaining: Math.max(0, invoiceTotal(i) - paidOfInvoice),
        };
      })
      .filter((i) => {
        if (i.remaining <= 0 || seen.has(i.id)) return false;
        seen.add(i.id);
        return true;
      });
  }, [partyId, isReceipt, allInvoices, allVouchers]);

  // Dynamic helper text so the "الفاتورة المرتبطة" field is self-explanatory:
  // it only shows a party's unpaid invoices AFTER a party is chosen.
  const invoiceHint = !partyId
    ? isReceipt
      ? "اختر العميل أولاً لتظهر الفواتير غير المسددة"
      : "اختر المورد أولاً لتظهر الفواتير غير المسددة"
    : invoiceOptions.length === 0
      ? "لا توجد فواتير غير مسددة لهذا الطرف — سيُسجَّل المبلغ كدفعة على الحساب"
      : "اختر فاتورة لتسوية رصيدها، أو اترك «دفعة على الحساب» لسداد عام";

  const save = async () => {
    let valid = true;
    if (!partyId) {
      setPartyError(isReceipt ? "اختر العميل." : "اختر المورّد.");
      valid = false;
    }
    if (!amount || Number(amount) <= 0) {
      setAmountError("أدخل مبلغاً صحيحاً أكبر من صفر.");
      valid = false;
    } else if (isNaN(Number(amount))) {
      setAmountError("المبلغ يجب أن يكون رقماً.");
      valid = false;
    }
    if (valid && invoiceId) {
      const opt = invoiceOptions.find((i) => i.id === invoiceId);
      if (opt && Number(amount) > opt.remaining) {
        setAmountError(
          `المبلغ يتجاوز المتبقي على الفاتورة (${formatAmount(opt.remaining, opt.currency)}).`,
        );
        valid = false;
      }
    }
    if (!valid) return;
    const input = {
      kind,
      date,
      partyId,
      partyKind: isReceipt ? ("customer" as const) : ("supplier" as const),
      invoiceId: invoiceId || undefined,
      amount: Number(amount),
      currency,
      method,
      notesPrint: notesPrint || undefined,
      notesInternal: notesInternal || undefined,
    };
    try {
      await (isReceipt ? createReceipt : createPayment).mutateAsync(input);
      navigate({ to: isReceipt ? "/receipts" : "/payments" });
    } catch {
      // mutation hooks surface errors via their own toast; keep err unset
    }
  };

  return (
    <>
      <PageCard title="بيانات السند" description="اختر الطرف والمبلغ وطريقة الاستلام / الدفع.">
        <div className="grid gap-3 md:grid-cols-3">
          <FormField label={isReceipt ? "العميل *" : "المورد *"} error={partyError ?? undefined}>
            <PartyCombobox
              kind={isReceipt ? "customer" : "supplier"}
              value={partyId}
              onChange={(v) => {
                setPartyId(v);
                setInvoiceId("");
                setPartyError(null);
              }}
              onCreateNew={() => setAddPartyOpen(true)}
              placeholder={isReceipt ? "اختر العميل" : "اختر المورد"}
            />
          </FormField>
          <Field label="الفاتورة المرتبطة (اختياري)">
            <Select
              value={invoiceId || "none"}
              onValueChange={(v) => setInvoiceId(v === "none" ? "" : v)}
              disabled={!partyId}
            >
              <SelectTrigger className="!h-10">
                <SelectValue placeholder="دفعة على الحساب" />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="none">— دفعة على الحساب —</SelectItem>
                {invoiceOptions.map((i) => (
                  <SelectItem key={i.id} value={i.id}>
                    {i.number} — متبقٍ {formatAmount(i.remaining, i.currency)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="mt-1 text-[11px] leading-snug text-muted-foreground">{invoiceHint}</p>
          </Field>
          <Field label="التاريخ">
            <Input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="h-10"
            />
          </Field>
          <FormField label="المبلغ *" error={amountError ?? undefined}>
            <Input
              type="number"
              value={amount}
              onChange={(e) => {
                setAmount(e.target.value === "" ? "" : Number(e.target.value));
                setAmountError(null);
              }}
              className="h-10"
            />
          </FormField>
          <Field label="العملة">
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
          </Field>
          <Field label={isReceipt ? "طريقة الاستلام" : "طريقة الدفع"}>
            <Select value={method} onValueChange={(v) => setMethod(v as VoucherMethod)}>
              <SelectTrigger className="!h-10">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="cash">نقدي</SelectItem>
                <SelectItem value="transfer">تحويل بنكي</SelectItem>
                <SelectItem value="check">شيك</SelectItem>
              </SelectContent>
            </Select>
          </Field>
        </div>
      </PageCard>

      <PageCard
        title="الملاحظات"
        description="ملاحظات الطباعة تظهر في المستند المطبوع، الملاحظات الداخلية للاستخدام الداخلي فقط."
      >
        <div className="grid gap-3 md:grid-cols-2">
          <div>
            <Label className="text-[11px] text-muted-foreground">ملاحظات الفاتورة (تُطبع)</Label>
            <Textarea rows={3} value={notesPrint} onChange={(e) => setNotesPrint(e.target.value)} />
          </div>
          <div>
            <Label className="text-[11px] text-muted-foreground flex items-center gap-1">
              <Lock className="h-3 w-3" /> ملاحظات داخلية (لا تُطبع)
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

      <PageCard title="مرفقات" description="ملفات مرفقة بالسند (نائب — لا يتم تخزين فعلي بعد).">
        <div className="rounded-lg border-2 border-dashed border-border p-8 text-center text-sm text-muted-foreground">
          اسحب الملفات هنا أو اضغط للرفع (نائب)
        </div>
      </PageCard>

      <div className="sticky bottom-0 -mx-6 border-t border-border bg-card/95 px-6 py-3 backdrop-blur">
        <div className="flex justify-end gap-2">
          <Button variant="ghost" onClick={() => history.back()}>
            <X className="h-4 w-4 ml-1" /> إلغاء
          </Button>
          <Button onClick={save} className="bg-primary text-primary-foreground">
            <Save className="h-4 w-4 ml-1" /> حفظ السند
          </Button>
        </div>
      </div>

      <PartyFormDialog
        kind={isReceipt ? "customer" : "supplier"}
        open={addPartyOpen}
        onClose={() => setAddPartyOpen(false)}
        onSubmit={(patch) => {
          setAddPartyOpen(false);
          const created = isReceipt
            ? addCustomer(patch as Parameters<typeof addCustomer>[0])
            : addSupplier(patch as Parameters<typeof addSupplier>[0]);
          created
            .then((p) => {
              if (p?.id) {
                setPartyId(p.id);
                setInvoiceId("");
                setPartyError(null);
              }
            })
            .catch(() => {});
        }}
      />
    </>
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
