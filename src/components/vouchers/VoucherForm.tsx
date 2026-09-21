import { useState, useMemo, useEffect } from "react";
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
import { FormattedAmountInput } from "@/components/invoices/InvoiceFormLayout";
import { PartyCombobox } from "@/components/vouchers/PartyCombobox";
import { PartyFormDialog } from "@/components/parties/PartyFormDialog";
import { addCustomer, addSupplier, type Currency } from "@/presentation/hooks/useParties";
import { CURRENCIES, currencySymbol, formatAmount } from "@/presentation/hooks/useCurrency";
import {
  useCreateReceiptVoucher,
  useCreatePaymentVoucher,
  useCancelVoucher,
  useVoucher,
  type VoucherKind,
  type VoucherMethod,
} from "@/presentation/hooks/useVouchers";
import { useInvoicesList } from "@/presentation/hooks/useInvoices";
import { useReturnsList } from "@/presentation/hooks/useReturns";
import { invoiceTotal } from "@/core/calculations/invoiceCalc";
import { convertForSettlement, round2dp, settleAmountAgainstRemaining } from "@erp/shared";
import { AlertTriangle, Save, X, Lock } from "lucide-react";

/**
 * Restate an amount in the linked invoice's currency using the rate entered
 * ON THIS VOUCHER right now (`convertForSettlement` — same helper the
 * backend uses in `PostgresVoucherRepository.create`/`cancel`), never either
 * side's own frozen historical rate. Returns null when FX is missing so the
 * UI can require a manual rate instead of silently comparing raw
 * cross-currency amounts (N12/N13).
 */
function toInvoiceCurrency(
  amount: number,
  from: { currency: string; exchangeRate?: number | null },
  invoiceCurrency: string,
): number | null {
  if (from.currency === invoiceCurrency) return amount;
  return convertForSettlement(amount, from.currency, invoiceCurrency, from.exchangeRate ?? null);
}

export function VoucherForm({
  kind,
  initialPartyId,
  initialInvoiceId,
  editId,
}: {
  kind: VoucherKind;
  /** Prefill party when opened from customer/supplier payments tab. */
  initialPartyId?: string;
  /**
   * Prefill the linked invoice when opened from an invoice's own page (F14,
   * Phase 1 audit — this used to not exist, so "new voucher" from an
   * invoice landed on a totally empty form with no party or invoice
   * selected). Only takes effect once the invoice actually appears in
   * `invoiceOptions` below, which already excludes cancelled invoices — so
   * a cancelled invoice's id here is harmlessly ignored, not specially
   * handled; the invoice page itself disables this action for a cancelled
   * invoice so the link is not reachable in that case at all.
   */
  initialInvoiceId?: string;
  /** Amend mode: load voucher, then cancel+recreate on save (no PUT API). */
  editId?: string;
}) {
  const navigate = useNavigate();
  const createReceipt = useCreateReceiptVoucher();
  const createPayment = useCreatePaymentVoucher();
  const cancelVoucher = useCancelVoucher();
  const { data: editing } = useVoucher(editId ?? "");
  const isReceipt = kind === "receipt";
  const [partyId, setPartyId] = useState(initialPartyId ?? "");
  const [invoiceId, setInvoiceId] = useState<string>(initialInvoiceId ?? "");
  const [amount, setAmount] = useState<number | "">("");
  const [discount, setDiscount] = useState<number | "">("");
  const [discountError, setDiscountError] = useState<string | null>(null);
  const [currency, setCurrency] = useState<Currency>("SYP");
  const [exchangeRate, setExchangeRate] = useState<number | "">("");
  const [fxError, setFxError] = useState<string | null>(null);
  const [method, setMethod] = useState<VoucherMethod>("cash");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const [notesPrint, setNotesPrint] = useState("");
  const [notesInternal, setNotesInternal] = useState("");
  const [partyError, setPartyError] = useState<string | null>(null);
  const [amountError, setAmountError] = useState<string | null>(null);
  const [addPartyOpen, setAddPartyOpen] = useState(false);
  const [hydratedEdit, setHydratedEdit] = useState(false);

  useEffect(() => {
    if (!editing || hydratedEdit) return;
    if (editing.kind !== kind) return;
    if (editing.status === "cancelled") return;
    setPartyId(editing.partyId);
    setInvoiceId(editing.invoiceId ?? "");
    setAmount(editing.amount);
    setDiscount(editing.discount && editing.discount > 0 ? editing.discount : "");
    setCurrency(editing.currency as Currency);
    setExchangeRate(editing.exchangeRate && editing.exchangeRate > 0 ? editing.exchangeRate : "");
    setMethod(editing.method);
    setDate(editing.date);
    setNotesPrint(editing.notesPrint ?? "");
    setNotesInternal(editing.notesInternal ?? "");
    setHydratedEdit(true);
  }, [editing, hydratedEdit, kind]);

  // Scoped to the selected party with a high limit — a global page-1 list
  // silently dropped older invoices for that party (looked like "only the last").
  const { data: invoicesData } = useInvoicesList(
    partyId ? { partyId, limit: 1000 } : { limit: 1000 },
  );
  const allInvoices = invoicesData?.data ?? [];
  // Returns are needed to compute the true remaining: backend does total - paid - activeReturns
  // (sale return credits the customer). Without this, the UI shows 44 while the backend correctly sees -72.
  const { data: returnsData } = useReturnsList({ limit: 1000 });
  const returnsByInvoice = useMemo(() => {
    const map = new Map<string, number>();
    for (const r of (returnsData?.data ?? []) as Array<{
      originalInvoiceId?: string | null;
      status: string;
      lines: Array<{ quantityKg: number; pricePerKg: number }>;
    }>) {
      if (!r.originalInvoiceId || r.status !== "active") continue;
      const sum = r.lines.reduce((s, l) => s + Number(l.quantityKg) * Number(l.pricePerKg), 0);
      map.set(r.originalInvoiceId, (map.get(r.originalInvoiceId) ?? 0) + sum);
    }
    return map;
  }, [returnsData]);

  const invoiceOptions = useMemo(() => {
    if (!partyId) return [];
    const wantedType = isReceipt ? "sale" : "entry";
    // Guard against duplicate invoice rows in the fetched data: dedupe by id so
    // we never render two <SelectItem> with the same value/key (which would make
    // the Radix dropdown appear to draw the same list twice).
    const seen = new Set<string>();
    // When amending, the amount currently on this voucher frees up on cancel —
    // add it back so the same (or smaller) amount still validates.
    const creditBack =
      editing && editing.status === "active" && editing.invoiceId
        ? (toInvoiceCurrency(
            editing.amount,
            {
              currency: editing.currency,
              exchangeRate: editing.exchangeRate ?? null,
            },
            // settled into invoice currency — look up invoice below
            allInvoices.find((i) => i.id === editing.invoiceId)?.currency ?? editing.currency,
          ) ?? 0)
        : 0;
    const editInvoiceId = editing?.invoiceId ?? "";

    return allInvoices
      .filter((i) => i.type === wantedType && i.status !== "cancelled" && i.partyId === partyId)
      .map((i) => {
        const returnsSum = returnsByInvoice.get(i.id) ?? 0;
        // Backend: remaining = total - paid - activeReturns (can be negative = credit)
        const rawRemaining = round2dp(invoiceTotal(i) - (i.paid ?? 0) - returnsSum);
        let remaining = Math.max(0, rawRemaining);
        // Show credit as 0 remaining (cannot collect more), but keep raw for validation message
        if (editInvoiceId && i.id === editInvoiceId)
          remaining = Math.max(0, remaining + creditBack);
        return { ...i, remaining, rawRemaining, returnsSum };
      })
      .filter((i) => {
        // Keep the linked invoice visible while amending even if remaining was 0
        // before credit-back (edge float cases).
        if (i.remaining <= 0 && i.id !== editInvoiceId) return false;
        if (seen.has(i.id)) return false;
        seen.add(i.id);
        return true;
      });
  }, [partyId, isReceipt, allInvoices, editing, returnsByInvoice]);

  // Dynamic helper text so the "الفاتورة المرتبطة" field is self-explanatory:
  // it only shows a party's unpaid invoices AFTER a party is chosen.
  const invoiceHint = !partyId
    ? isReceipt
      ? "اختر العميل أولاً لتظهر الفواتير غير المسددة"
      : "اختر المورد أولاً لتظهر الفواتير غير المسددة"
    : invoiceOptions.length === 0
      ? "لا توجد فواتير غير مسددة لهذا الطرف — سيُسجَّل المبلغ كدفعة على الحساب"
      : "اختر فاتورة لتسديدها، أو اترك «دفعة على الحساب» لسداد عام";

  // A payment left "on account" is NOT converted: it is booked as an independent credit in its
  // own currency and never reduces open invoices in another currency. Surface that before
  // saving so the operator picks the invoice (which applies the payment-time exchange rate).
  const offCurrencyOpenInvoices = !invoiceId
    ? invoiceOptions.filter((i) => i.currency !== currency)
    : [];

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
    const discountVal = Number(discount) || 0;
    if (discountVal < 0) {
      setDiscountError("الخصم لا يمكن أن يكون سالباً.");
      valid = false;
    } else if (amount && discountVal > Number(amount)) {
      setDiscountError("الخصم لا يمكن أن يتجاوز مبلغ السند.");
      valid = false;
    } else {
      setDiscountError(null);
    }
    if (currency !== "USD" && !(Number(exchangeRate) > 0)) {
      setFxError("سعر الصرف مطلوب يدوياً لكل عملية ليست بالدولار (عملة الأساس USD)");
      valid = false;
    } else {
      setFxError(null);
    }
    if (valid && invoiceId) {
      const opt = invoiceOptions.find((i) => i.id === invoiceId);
      if (opt) {
        const voucherFx = {
          currency,
          exchangeRate: Number(exchangeRate) > 0 ? Number(exchangeRate) : null,
        };
        if (opt.currency !== currency && !(Number(exchangeRate) > 0)) {
          setFxError("عملة السند تختلف عن عملة الفاتورة — أدخل سعر الصرف يدوياً أولاً");
          valid = false;
        } else {
          // Same closure rule as the backend: paying the exact remaining (to the
          // payment currency's smallest unit) settles it exactly.
          const settled = settleAmountAgainstRemaining(
            Number(amount),
            currency,
            opt.currency,
            voucherFx.exchangeRate,
            opt.remaining,
          );
          if (settled == null) {
            setFxError("تعذر التحويل — أدخل سعر صرف صحيح لهذه العملية");
            valid = false;
          } else if (settled > opt.remaining + 0.01) {
            setAmountError(
              `بعد التحويل ${formatAmount(settled, opt.currency)} يتجاوز المتبقي ${formatAmount(opt.remaining, opt.currency)}.`,
            );
            valid = false;
          }
        }
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
      discount: discountVal > 0 ? discountVal : undefined,
      currency,
      exchangeRate: Number(exchangeRate) > 0 ? Number(exchangeRate) : undefined,
      method,
      notesPrint: notesPrint || undefined,
      notesInternal: notesInternal || undefined,
    };
    try {
      // Amend = cancel the old voucher first (frees remaining), then create.
      if (editId && editing?.status === "active") {
        await cancelVoucher.mutateAsync(editId);
      }
      await (isReceipt ? createReceipt : createPayment).mutateAsync(input);
      navigate({ to: isReceipt ? "/receipts" : "/payments" });
    } catch {
      // mutation hooks surface errors via their own toast; keep err unset
    }
  };

  const selectedInvoice = invoiceOptions.find((i) => i.id === invoiceId);
  const showFxField =
    currency !== "USD" || Boolean(selectedInvoice && selectedInvoice.currency !== currency);

  // Live preview of settlement math (multiply when paying USD against SYP):
  // amount × rate → invoice currency. Shown whenever both amount and rate
  // are present so the operator never has to guess whether we divide or multiply.
  const settlementPreview = useMemo(() => {
    if (!selectedInvoice || !amount || Number(amount) <= 0) return null;
    if (selectedInvoice.currency === currency) {
      return { settled: Number(amount), rate: null as number | null };
    }
    const rate = Number(exchangeRate);
    if (!(rate > 0)) return null;
    const settled = settleAmountAgainstRemaining(
      Number(amount),
      currency,
      selectedInvoice.currency,
      rate,
      selectedInvoice.remaining,
    );
    if (settled == null) return null;
    return { settled, rate };
  }, [selectedInvoice, amount, currency, exchangeRate]);

  return (
    <>
      {editId && editing?.status === "active" && (
        <div className="mb-3 rounded-lg border border-warning/40 bg-warning/10 px-4 py-2 text-sm text-warning-foreground">
          تعديل السند {editing.number} — عند الحفظ يُلغى السند الحالي ويُنشأ سند جديد بالقيم
          المعدّلة.
        </div>
      )}
      <PageCard title="بيانات السند" description="اختر الطرف والمبلغ وطريقة الاستلام / الدفع.">
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
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
            {offCurrencyOpenInvoices.length > 0 && (
              <div
                role="alert"
                data-testid="on-account-fx-warning"
                className="mt-1 flex items-start gap-2 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-2 text-[11px] leading-snug text-foreground"
              >
                <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-warning" />
                <p>
                  <span className="font-bold text-warning">تنبيه:</span> لدى هذا الطرف{" "}
                  {offCurrencyOpenInvoices.length} فاتورة مفتوحة بعملة{" "}
                  {[
                    ...new Set(
                      offCurrencyOpenInvoices.map((i) => currencySymbol(i.currency as Currency)),
                    ),
                  ].join(" / ")}
                  . الدفعة على الحساب بعملة {currencySymbol(currency)} تُسجَّل رصيداً مستقلاً
                  بعملتها ولا تخفض رصيد تلك الفواتير — اختر الفاتورة ليُطبَّق سعر الصرف وقت الدفع.
                </p>
              </div>
            )}
          </Field>
          <Field label="التاريخ">
            <Input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="h-10"
            />
          </Field>
          <FormField label="مبلغ الدفعة (الإجمالي) *" error={amountError ?? undefined}>
            <FormattedAmountInput
              value={amount}
              onChange={(v) => {
                setAmount(v);
                setAmountError(null);
              }}
              className="h-10"
              ariaLabel="مبلغ الدفعة"
            />
            {settlementPreview && selectedInvoice && selectedInvoice.currency !== currency ? (
              <p className="mt-1 text-[11px] leading-snug text-muted-foreground" dir="ltr">
                ≈ {formatAmount(settlementPreview.settled, selectedInvoice.currency)}
                {settlementPreview.rate != null
                  ? ` (${Number(amount)} × ${settlementPreview.rate})`
                  : ""}
                {" · "}متبقٍ {formatAmount(selectedInvoice.remaining, selectedInvoice.currency)}
              </p>
            ) : null}
          </FormField>
          <FormField label="الخصم (يُخصم من النقد)" error={discountError ?? undefined}>
            <FormattedAmountInput
              value={discount}
              onChange={(v) => {
                setDiscount(v);
                setDiscountError(null);
              }}
              className="h-10"
              ariaLabel="الخصم"
            />
            {amount && Number(amount) > 0 && Number(discount) > 0 ? (
              <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                الصافي نقداً:{" "}
                {formatAmount(Math.max(0, Number(amount) - (Number(discount) || 0)), currency)}
              </p>
            ) : null}
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
          {showFxField && (
            <div className="min-w-0 sm:col-span-2 lg:col-span-1">
              <FormField label="سعر الصرف (ل.س / $) — يدوي لكل عملية" error={fxError ?? undefined}>
                <FormattedAmountInput
                  value={exchangeRate}
                  onChange={(v) => {
                    setExchangeRate(v);
                    setFxError(null);
                  }}
                  className="h-10 min-w-0"
                  placeholder="أدخل سعر الصرف يدوياً"
                  ariaLabel="سعر الصرف"
                />
                <p className="mt-1 text-[11px] leading-snug text-muted-foreground">
                  دولار → ليرة: ضرب المبلغ × السعر · ليرة → دولار: قسمة المبلغ ÷ السعر
                </p>
              </FormField>
            </div>
          )}
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
