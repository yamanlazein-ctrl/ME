import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { currencySymbol, type Currency } from "@/presentation/hooks/useCurrency";
import { formatMoney } from "@/shared/utils/formatNumber";
import type { OutstandingRow } from "@/core/calculations/ledgerCalc";
import type { PartyKind } from "@/domain/entities/Party";
import type { SettleInvoicesResponse } from "@/contracts/statement";
import { useSettleInvoices } from "@/presentation/hooks/useStatement";
import { allocateSettlementPayment, settlementRequiresExchangeRate } from "@erp/shared";
import { useSypRateSoftWarning } from "@/presentation/hooks/useSypRateSoftCheck";
import { printDocument } from "@/components/print/printPortal";
import { SettlementPrintDocument } from "@/components/print/SettlementPrintDocument";

type Mode = "full" | "partial";

function Amt({ amount, currency }: { amount: number; currency: string }) {
  return (
    <span className="tabular-nums">
      {formatMoney(amount)} {currencySymbol(currency as Currency)}
    </span>
  );
}

export function SettlementDialog({
  open,
  onOpenChange,
  partyId,
  partyName,
  partyCode,
  kind,
  outstanding,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  partyId: string;
  partyName: string;
  partyCode?: string | null;
  kind: PartyKind;
  outstanding: OutstandingRow[];
}) {
  const settle = useSettleInvoices(partyId, kind);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [settlementCurrency, setSettlementCurrency] = useState<Currency>("USD");
  const [exchangeRate, setExchangeRate] = useState<number | "">("");
  const [mode, setMode] = useState<Mode>("full");
  const [amountPaid, setAmountPaid] = useState<number | "">("");
  const [discount, setDiscount] = useState<number | "">("");
  const [method, setMethod] = useState<"cash" | "transfer" | "check" | "card">("cash");
  const [softWarningAcked, setSoftWarningAcked] = useState(false);

  useEffect(() => {
    if (!open) return;
    setSelected(new Set(outstanding.map((r) => r.invoiceId)));
    const currencies = [...new Set(outstanding.map((r) => r.currency))];
    setSettlementCurrency(currencies.length === 1 ? currencies[0]! : "USD");
    setExchangeRate("");
    setMode("full");
    setAmountPaid("");
    setDiscount("");
    setMethod("cash");
    setSoftWarningAcked(false);
  }, [open, outstanding]);

  const selectedRows = useMemo(
    () => outstanding.filter((r) => selected.has(r.invoiceId)),
    [outstanding, selected],
  );

  const needsRate = settlementRequiresExchangeRate(
    settlementCurrency,
    selectedRows.map((r) => r.currency),
  );

  // Whichever currency in this settlement is actually SYP-denominated (the
  // settlement currency itself, or any invoice being paid) — the rate typed
  // above pairs with THAT currency regardless of which one it is.
  const sypSide =
    settlementCurrency === "SYP" || selectedRows.some((r) => r.currency === "SYP")
      ? "SYP"
      : settlementCurrency;
  const enteredRateNum = Number(exchangeRate) > 0 ? Number(exchangeRate) : null;
  const softWarning = useSypRateSoftWarning(sypSide, enteredRateNum);
  useEffect(() => {
    setSoftWarningAcked(false);
  }, [enteredRateNum, sypSide]);

  const preview = useMemo(() => {
    if (selectedRows.length === 0) {
      return {
        totalDue: 0,
        allocations: [] as ReturnType<typeof allocateSettlementPayment>["allocations"],
        error: null as string | null,
      };
    }
    try {
      const rate = Number(exchangeRate);
      const rateArg = needsRate ? (rate > 0 ? rate : null) : rate > 0 ? rate : undefined;
      const dueProbe = allocateSettlementPayment({
        invoices: selectedRows.map((r) => ({
          invoiceId: r.invoiceId,
          number: r.number,
          date: r.date,
          currency: r.currency,
          remaining: r.remaining,
        })),
        amountPaid: 1e15,
        settlementCurrency,
        exchangeRate: rateArg,
      });
      const totalDue = dueProbe.totalDueInSettlement;
      const discountVal = typeof discount === "number" && discount > 0 ? discount : 0;
      const pay =
        mode === "full"
          ? totalDue
          : typeof amountPaid === "number" && amountPaid + discountVal > 0
            ? amountPaid + discountVal
            : 0;
      if (!(pay > 0)) {
        return { totalDue, allocations: [], error: null };
      }
      const allocated = allocateSettlementPayment({
        invoices: selectedRows.map((r) => ({
          invoiceId: r.invoiceId,
          number: r.number,
          date: r.date,
          currency: r.currency,
          remaining: r.remaining,
        })),
        amountPaid: pay,
        settlementCurrency,
        exchangeRate: rateArg,
      });
      return {
        totalDue,
        allocations: allocated.allocations,
        error: null as string | null,
      };
    } catch (e) {
      return {
        totalDue: 0,
        allocations: [],
        error: e instanceof Error ? e.message : "تعذّر احتساب الدفعة",
      };
    }
  }, [selectedRows, settlementCurrency, exchangeRate, needsRate, mode, amountPaid, discount]);

  const toggle = (id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (selected.size === outstanding.length) setSelected(new Set());
    else setSelected(new Set(outstanding.map((r) => r.invoiceId)));
  };

  const discountVal = typeof discount === "number" && discount > 0 ? discount : 0;
  const cashAmount =
    mode === "full"
      ? Math.max(0, preview.totalDue - discountVal)
      : typeof amountPaid === "number"
        ? amountPaid
        : 0;
  const effectiveAmount = cashAmount + discountVal;
  // Paying more than everything selected: a customer's surplus is booked as an
  // advance (on-account receipt → credit balance, cash into the drawer); a
  // supplier overpayment, or a concession on top of a surplus, is refused
  // server-side — mirror that here instead of failing on submit.
  const allocatedTotal = preview.allocations.reduce((s, a) => s + a.amountInSettlementCurrency, 0);
  const surplus =
    preview.allocations.length > 0
      ? Math.max(0, Math.round((effectiveAmount - allocatedTotal) * 100) / 100)
      : 0;
  const surplusBlocked = surplus > 0.01 && (kind !== "customer" || discountVal > 0);

  const canSubmit =
    selectedRows.length > 0 &&
    effectiveAmount > 0 &&
    !preview.error &&
    !surplusBlocked &&
    preview.allocations.length > 0 &&
    (!needsRate || Number(exchangeRate) > 0) &&
    (!softWarning || softWarningAcked) &&
    !settle.isPending;

  const onSubmit = async () => {
    if (!canSubmit) return;
    try {
      const res: SettleInvoicesResponse = await settle.mutateAsync({
        invoiceIds: selectedRows.map((r) => r.invoiceId),
        amountPaid: cashAmount,
        discount: discountVal > 0 ? discountVal : undefined,
        currency: settlementCurrency,
        exchangeRate: Number(exchangeRate) > 0 ? Number(exchangeRate) : undefined,
        method,
      });
      onOpenChange(false);
      printDocument(
        <SettlementPrintDocument
          partyName={partyName}
          partyCode={partyCode}
          partyKind={kind}
          settlement={res}
        />,
      );
    } catch {
      /* toast handled by hook */
    }
  };

  const settleSym = currencySymbol(settlementCurrency);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        dir="rtl"
        className="!max-w-4xl w-[calc(100vw-2rem)] max-h-[92vh] overflow-y-auto"
      >
        <DialogHeader>
          <DialogTitle>تسجيل دفعة على الفواتير</DialogTitle>
        </DialogHeader>

        <div className="space-y-4 text-sm">
          <div className="rounded-md border overflow-x-auto">
            <table className="w-full min-w-[720px] text-right text-sm">
              <thead className="bg-secondary/60 text-[11px] font-semibold text-muted-foreground">
                <tr className="[&>th]:px-3 [&>th]:py-2">
                  <th className="w-10">
                    <input
                      type="checkbox"
                      checked={outstanding.length > 0 && selected.size === outstanding.length}
                      onChange={toggleAll}
                      aria-label="تحديد الكل"
                    />
                  </th>
                  <th>الفاتورة</th>
                  <th>العملة</th>
                  <th className="text-left">الإجمالي</th>
                  <th className="text-left">المدفوع</th>
                  <th className="text-left">المتبقي</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {outstanding.map((r) => (
                  <tr key={r.invoiceId} className="[&>td]:px-3 [&>td]:py-2">
                    <td>
                      <input
                        type="checkbox"
                        checked={selected.has(r.invoiceId)}
                        onChange={() => toggle(r.invoiceId)}
                        aria-label={`تحديد ${r.number}`}
                      />
                    </td>
                    <td className="font-semibold tabular-nums text-primary">{r.number}</td>
                    <td>{r.currency}</td>
                    <td className="text-left">
                      <Amt amount={r.total} currency={r.currency} />
                    </td>
                    <td className="text-left text-muted-foreground">
                      <Amt amount={r.paid} currency={r.currency} />
                    </td>
                    <td className="text-left font-semibold text-warning">
                      <Amt amount={r.remaining} currency={r.currency} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="grid gap-3 md:grid-cols-3">
            <div>
              <Label className="mb-1 block text-[11px] font-semibold text-muted-foreground">
                عملة الدفعة
              </Label>
              <Select
                value={settlementCurrency}
                onValueChange={(v) => setSettlementCurrency(v as Currency)}
              >
                <SelectTrigger className="!h-10">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="SYP">ل.س SYP</SelectItem>
                  <SelectItem value="USD">$ USD</SelectItem>
                  <SelectItem value="EUR">€ EUR</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <Label className="mb-1 block text-[11px] font-semibold text-muted-foreground">
                سعر صرف الدفعة (وقت الدفع) {needsRate ? "(مطلوب)" : "(اختياري)"}
              </Label>
              <Input
                type="number"
                min={0}
                step="0.01"
                className="h-10 tabular-nums"
                placeholder="وحدات العملة لكل 1 USD"
                value={exchangeRate}
                onChange={(e) =>
                  setExchangeRate(e.target.value === "" ? "" : Number(e.target.value))
                }
              />
              {softWarning && (
                <div
                  role="alert"
                  data-testid="settlement-syp-rate-soft-warning"
                  className="mt-2 rounded-md border border-warning/40 bg-warning/10 px-2.5 py-2 text-[11px] leading-snug text-foreground"
                >
                  <p>{softWarning}</p>
                  <label className="mt-1.5 flex items-center gap-1.5 font-semibold">
                    <input
                      type="checkbox"
                      checked={softWarningAcked}
                      onChange={(e) => setSoftWarningAcked(e.target.checked)}
                    />
                    السعر صحيح ومقصود، تابع الحفظ
                  </label>
                </div>
              )}
            </div>
            <div>
              <Label className="mb-1 block text-[11px] font-semibold text-muted-foreground">
                طريقة الدفع
              </Label>
              <Select value={method} onValueChange={(v) => setMethod(v as typeof method)}>
                <SelectTrigger className="!h-10">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="cash">نقدي</SelectItem>
                  <SelectItem value="transfer">تحويل</SelectItem>
                  <SelectItem value="check">شيك</SelectItem>
                  <SelectItem value="card">بطاقة</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant={mode === "full" ? "default" : "outline"}
              onClick={() => {
                setMode("full");
                setAmountPaid("");
              }}
            >
              دفعة كاملة
            </Button>
            <Button
              type="button"
              size="sm"
              variant={mode === "partial" ? "default" : "outline"}
              onClick={() => setMode("partial")}
            >
              دفعة جزئية
            </Button>
            {mode === "partial" && (
              <Input
                type="number"
                min={0}
                step="0.01"
                className="h-9 w-40 tabular-nums"
                placeholder={`المبلغ النقدي ${settleSym}`}
                value={amountPaid}
                onChange={(e) => setAmountPaid(e.target.value === "" ? "" : Number(e.target.value))}
              />
            )}
            <Input
              type="number"
              min={0}
              step="0.01"
              className="h-9 w-40 tabular-nums"
              placeholder={`مسامحة ${settleSym}`}
              value={discount}
              onChange={(e) => setDiscount(e.target.value === "" ? "" : Number(e.target.value))}
              aria-label="المسامحة"
            />
          </div>

          <div className="rounded-md border bg-secondary/30 px-4 py-3 space-y-1">
            <div>
              إجمالي المستحق بعملة الدفعة:{" "}
              <span className="font-bold">
                <Amt amount={preview.totalDue} currency={settlementCurrency} />
              </span>
            </div>
            <div>
              النقد الفعلي:{" "}
              <span className="font-bold">
                <Amt amount={cashAmount} currency={settlementCurrency} />
              </span>
              {method === "cash"
                ? ` → صندوق ${settlementCurrency}`
                : " (بدون أثر على الصندوق النقدي)"}
            </div>
            {discountVal > 0 && (
              <div>
                المسامحة:{" "}
                <span className="font-bold">
                  <Amt amount={discountVal} currency={settlementCurrency} />
                </span>
                {" · "}إجمالي تخفيض الذمة:{" "}
                <span className="font-bold">
                  <Amt amount={effectiveAmount} currency={settlementCurrency} />
                </span>
              </div>
            )}
            {surplus > 0.01 && !surplusBlocked && (
              <div
                className="rounded border border-success/40 bg-success/10 px-2 py-1 text-xs text-success"
                data-testid="settlement-surplus"
              >
                تُسدَّد الفواتير المحددة بالكامل، والفائض{" "}
                <span className="font-bold">
                  <Amt amount={surplus} currency={settlementCurrency} />
                </span>{" "}
                يُسجَّل دفعة مقدمة (رصيد دائن للعميل) ويدخل الصندوق مع باقي المبلغ.
              </div>
            )}
            {surplusBlocked && (
              <div className="text-destructive text-xs">
                {kind !== "customer"
                  ? "المبلغ أكبر من المستحق على الفواتير المحددة — سجّل الفرق كسند دفع مستقل إن كان دفعة مقدمة للمورد."
                  : "لا يمكن منح مسامحة عندما يتجاوز المبلغ المستحق — أزل المسامحة."}
              </div>
            )}
            {preview.error && <div className="text-destructive text-xs">{preview.error}</div>}
          </div>

          {preview.allocations.length > 0 && (
            <div className="rounded-md border overflow-x-auto">
              <div className="px-3 py-2 text-[11px] font-semibold text-muted-foreground bg-secondary/40">
                توزيع المبلغ على الفواتير
              </div>
              <table className="w-full min-w-[640px] text-right text-xs">
                <thead>
                  <tr className="[&>th]:px-3 [&>th]:py-1.5 text-muted-foreground">
                    <th>الفاتورة</th>
                    <th>من المتبقي</th>
                    <th className="text-left">بعملة الدفعة ({settleSym})</th>
                    <th className="text-left">بعملة الفاتورة</th>
                    <th className="text-left">المتبقي بعد</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {preview.allocations.map((a) => (
                    <tr key={a.invoiceId} className="[&>td]:px-3 [&>td]:py-1.5">
                      <td className="tabular-nums font-semibold">{a.number}</td>
                      <td className="tabular-nums text-muted-foreground">
                        {formatMoney(a.remainingBefore)} {a.invoiceCurrency}
                      </td>
                      <td className="text-left tabular-nums">
                        {formatMoney(a.amountInSettlementCurrency)}
                      </td>
                      <td className="text-left tabular-nums">
                        {formatMoney(a.amountInInvoiceCurrency)} {a.invoiceCurrency}
                      </td>
                      <td className="text-left tabular-nums">
                        {formatMoney(a.remainingAfterInInvoiceCurrency)} {a.invoiceCurrency}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        <DialogFooter className="gap-2 sm:justify-start">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            إلغاء
          </Button>
          <Button type="button" disabled={!canSubmit} onClick={() => void onSubmit()}>
            {settle.isPending ? "جارٍ التسجيل…" : "تأكيد الدفعة وطباعة"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
