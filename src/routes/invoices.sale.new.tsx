import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState } from "react";
import { Package, Palette, Plus, UserPlus } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { InvoiceHeader } from "@/components/invoices/InvoiceHeader";
import { ExitWithoutSavingButton } from "@/components/invoices/ExitWithoutSaving";
import { colorById, fabricById, rollById, useInventory } from "@/presentation/hooks/useInventory";
import { addCustomer, customers } from "@/presentation/hooks/useParties";
import { currencySymbol } from "@/presentation/hooks/useCurrency";
import type { Currency } from "@/domain/types";
import { useCreateInvoice, nextInvoiceNumber } from "@/presentation/hooks/useInvoices";
import { toast } from "sonner";
import { printDocument } from "@/components/print/printPortal";
import { InvoicePrintDocument } from "@/components/print/InvoicePrintDocument";
import { useSettings } from "@/presentation/hooks/useSettings";
import { useOrder, useFulfillOrder, matchRollsForItem } from "@/presentation/hooks/useOrders";
import { DocumentFooter } from "@/components/layout/DocumentFooter";
import { useDocumentShortcuts } from "@/hooks/use-document-shortcuts";
import { cn } from "@/lib/utils";
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
import {
  HeaderField,
  TotalCell,
  TotalInputCell,
  MoneyInputCell,
} from "@/components/invoices/InvoiceFormLayout";
import { SaleLineCard } from "@/components/invoices/SaleLineCard";
import { QuickCustomerDialog } from "@/components/invoices/QuickCustomerDialog";
import {
  type SaleLine,
  emptyLine,
  cloneStickyFields,
  cloneFabricOnly,
  lineHasData,
  lineTotal,
} from "@/components/invoices/sale-types";
import { formatNumber, formatMoney, formatQuantity } from "@/shared/utils/formatNumber";


type SaleSearch = { fromOrder?: string };

export const Route = createFileRoute("/invoices/sale/new")({
  validateSearch: (s: Record<string, unknown>): SaleSearch => ({
    fromOrder: typeof s.fromOrder === "string" ? s.fromOrder : undefined,
  }),
  component: SaleInvoicePage,
});

function SaleInvoicePage() {
  useInventory();
  const navigate = useNavigate();
  const search = Route.useSearch();
  const fromOrderId = search.fromOrder;
  const create = useCreateInvoice();
  const fromOrder = useOrder(fromOrderId ?? "");
  const fulfillOrder = useFulfillOrder();

  const [customerId, setCustomerId] = useState("");
  const [currency, setCurrency] = useState<Currency | "">("");
  const [date, setDate] = useState(new Date().toISOString().slice(0, 10));
  const settingsSnap = useSettings();
  const enabledPaymentMethods = settingsSnap.paymentMethods.filter((m) => m.enabled);
  const warehousesList = settingsSnap.warehouses;
  const [paymentMethod, setPaymentMethod] = useState(enabledPaymentMethods[0]?.name ?? "نقدي");
  const [reference, setReference] = useState("");
  const [warehouse, setWarehouse] = useState(
    (warehousesList.find((w) => w.isDefault) ?? warehousesList[0])?.id ?? "",
  );
  const [notes, setNotes] = useState("");
  const invoiceNo = useMemo(() => nextInvoiceNumber("sale"), []);

  const [lines, setLines] = useState<SaleLine[]>([emptyLine()]);
  const [discount, setDiscount] = useState<number | "">("");
  const [tax, setTax] = useState<number | "">("");
  const [paid, setPaid] = useState<number | "">("");
  const [error, setError] = useState<string | null>(null);
  const [quickCustomer, setQuickCustomer] = useState(false);

  const fabricRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const prefilledRef = useRef<string | null>(null);
  useEffect(() => {
    if (!fromOrderId || !fromOrder.data || prefilledRef.current === fromOrderId) return;
    const order = fromOrder.data;
    prefilledRef.current = fromOrderId;
    if (order.customerId) setCustomerId(order.customerId);
    if (order.currency) setCurrency(order.currency);
    setReference(order.code);
    const prefilled: SaleLine[] = [];
    for (const it of order.items) {
      const m = matchRollsForItem(it as Parameters<typeof matchRollsForItem>[0]);
      const rollId = m.rollIds[0];
      const roll = rollId ? rollById(rollId) : undefined;
      if (!roll) continue;
      const color = colorById(roll.colorId);
      const fabric = color ? fabricById(color.fabricId) : undefined;
      if (!color || !fabric) continue;
      const newLine = emptyLine();
      prefilled.push({
        ...newLine,
        fabricId: fabric.id,
        fabricName: fabric.name,
        colorId: color.id,
        colorName: color.name,
        colorCode: color.code,
        rollId: roll.id,
        quantityKg: Math.min(it.requestedKg, roll.remainingKg),
        pricePerKg: roll.salePricePerKg ?? roll.pricePerKg ?? 0,
        discountAmount: 0,
        note: it.notes ?? undefined,
      });
    }
    if (prefilled.length > 0) setLines(prefilled);
  }, [fromOrderId, fromOrder.data]);

  const dataLines = lines.filter(lineHasData);
  const subtotal = dataLines.reduce((s, l) => s + l.quantityKg * l.pricePerKg, 0);
  const totalQty = dataLines.reduce((s, l) => s + (l.quantityKg || 0), 0);
  const totalAfter = dataLines.reduce((s, l) => s + lineTotal(l), 0);
  const netTotal = totalAfter - (Number(discount) || 0) + (Number(tax) || 0);
  const remaining = Math.max(0, netTotal - (Number(paid) || 0));
  const isUSD = currency === "USD";
  const moneyClass = isUSD ? "text-success" : "text-foreground";

  const updateLine = (id: string, patch: Partial<SaleLine>) =>
    setLines((p) => p.map((l) => (l.id === id ? { ...l, ...patch } : l)));
  const removeLine = (id: string) =>
    setLines((p) => {
      const next = p.filter((x) => x.id !== id);
      return next.length === 0 ? [emptyLine()] : next;
    });
  const appendRowAndFocus = () => {
    const last = lines.filter(lineHasData).at(-1);
    const row: SaleLine = last ? { ...emptyLine(), ...cloneStickyFields(last) } : emptyLine();
    setLines((p) => [...p, row]);
    setTimeout(() => fabricRefs.current[row.id]?.focus(), 0);
  };

  /** Add a new row with the SAME fabric but EMPTY color — used for multi-color per fabric invoices. */
  const addColorForSameFabric = (lineId: string) => {
    const currentLine = lines.find((l) => l.id === lineId);
    if (!currentLine || !currentLine.fabricId) return;
    const newLine: SaleLine = {
      ...emptyLine(),
      ...cloneFabricOnly(currentLine),
    };
    const idx = lines.findIndex((l) => l.id === lineId);
    setLines((p) => {
      const next = [...p];
      next.splice(idx + 1, 0, newLine);
      return next;
    });
    setTimeout(() => fabricRefs.current[newLine.id]?.focus(), 0);
  };

  const save = async (thenPrint: boolean, thenNew = false) => {
    setError(null);
    if (!customerId) return setError("يرجى تحديد العميل.");
    if (!currency) return setError("اختر العملة (دولار $ أو ليرة سورية ل.س) قبل الحفظ.");
    const valid = lines.filter((l) => l.fabricId && l.colorId && l.rollId && l.quantityKg > 0);
    if (!valid.length) return setError("أضف على الأقل بنداً واحداً كاملاً.");
    if ((Number(discount) || 0) < 0) return setError("الخصم الكلي لا يمكن أن يكون سالباً.");
    if ((Number(tax) || 0) < 0) return setError("الضريبة لا يمكن أن تكون سالبة.");
    const paidAmount = Number(paid) || 0;
    if (paidAmount < 0) return setError("المبلغ المدفوع لا يمكن أن يكون سالباً.");
    if (paidAmount > netTotal) return setError("المبلغ المدفوع أكبر من الإجمالي الكلي للفاتورة.");
    for (const l of valid) {
      // Guard against values that exceed the DB numeric(12,2) columns.
      if (!Number.isFinite(l.pricePerKg) || l.pricePerKg <= 0) {
        return setError("سعر البند غير صالح (أدخل رقماً أكبر من صفر).");
      }
      if (l.pricePerKg > 9_999_999_999) {
        return setError("سعر البند كبير جداً — الحد الأقصى 9,999,999,999.");
      }
      if (l.quantityKg > 9_999_999_999) {
        return setError("كمية البند كبيرة جداً — الحد الأقصى 9,999,999,999 كغ.");
      }
      if ((l.discountAmount || 0) < 0) {
        return setError("الخصم لا يمكن أن يكون سالباً.");
      }
      if ((l.discountAmount || 0) > l.quantityKg * l.pricePerKg) {
        return setError("الخصم لا يمكن أن يتجاوز إجمالي البند.");
      }
      const roll = rollById(l.rollId);
      if (roll && l.quantityKg > roll.remainingKg) {
        return setError(`الكمية في الصبغة #${roll.rollNo} تتجاوز المتاح (${roll.remainingKg} كغ).`);
      }
    }
    const combinedNotes = [
      reference && `المرجع: ${reference}`,
      warehouse && warehouse !== "main" && `المستودع: ${warehouse}`,
      paymentMethod && `طريقة الدفع: ${paymentMethod}`,
      notes,
    ]
      .filter(Boolean)
      .join(" • ");
    const methodEnum =
      paymentMethod === "تحويل بنكي" || paymentMethod === "بنكي"
        ? "transfer"
        : paymentMethod === "شيك" || paymentMethod === "cheque" || paymentMethod === "check"
          ? "check"
          : paymentMethod === "بطاقة" || paymentMethod === "card"
            ? "card"
            : "cash";
    const res = await create.mutateAsync({
      tenantId: "dev-tenant",
      number: nextInvoiceNumber("sale"),
      type: "sale",
      date,
      partyId: customerId,
      partyType: "customer",
      currency,
      discount: Number(discount) || 0,
      tax: Number(tax) || 0,
      paid: paidAmount,
      paymentMethod: methodEnum,
      orderId: fromOrderId || undefined,
      lines: valid.map((l) => ({
        id: l.id,
        fabricId: l.fabricId,
        colorId: l.colorId,
        rollId: l.rollId,
        quantityKg: l.quantityKg,
        pieces: l.pieces,
        pricePerKg: l.pricePerKg,
        discountAmount: l.discountAmount,
        note: l.note,
      })),
      notes: combinedNotes,
    });
    if (!res.ok) {
      const rawErr = (res as any).error ?? {};
      const details = rawErr.details as Record<string, string[]> | undefined;
      const firstDetail = details ? details[Object.keys(details)[0]]?.[0] : undefined;
      return setError(
        typeof rawErr === "string"
          ? rawErr
          : firstDetail
            ? `${rawErr.message} — ${firstDetail}`
            : (rawErr.message ?? "فشل إنشاء الفاتورة"),
      );
    }
    const inv = res.value;
    toast.success(`تم إنشاء الفاتورة ${inv.number} بنجاح`);
    if (fromOrderId) await fulfillOrder.mutateAsync({ orderId: fromOrderId, invoiceId: inv.id });
    if (thenPrint) printDocument(<InvoicePrintDocument invoice={inv} />);
    if (thenNew) {
      resetForm();
      return;
    }
    navigate({ to: "/invoices/$id", params: { id: inv.id } });
  };

  const resetForm = () => {
    setCustomerId("");
    setLines([emptyLine()]);
    setDiscount("");
    setTax("");
    setPaid("");
    setReference("");
    setNotes("");
    setError(null);
  };
  useDocumentShortcuts({ onSave: () => save(false), onNew: () => resetForm() });
  const customer = customerId ? customers.find((c) => c.id === customerId) : undefined;

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-[1400px] space-y-2 pb-24">
        <InvoiceHeader
          variant="sale"
          invoiceNumber={invoiceNo}
          date={date}
          status={dataLines.length === 0 ? "مسودة" : "جاهزة للحفظ"}
          actions={<ExitWithoutSavingButton />}
        />
        {fromOrderId && (
          <div className="flex items-center justify-between gap-3 rounded-lg border border-primary/40 bg-primary/5 px-4 py-2 text-xs">
            <span className="font-semibold text-foreground">
              تحويل من الطلب {fromOrder.data?.code ?? fromOrderId} — البنود معبأة تلقائياً
            </span>
          </div>
        )}

        <section className="rounded-xl border border-border bg-card shadow-soft">
          <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
            <div className="flex items-center gap-2">
              <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                <Package className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <h2 className="text-sm font-bold text-foreground">بنود الفاتورة</h2>
                <p className="text-[11px] text-muted-foreground">
                  أضف كل بند كبطاقة مستقلة — اختر القماش، اللون، الصبغة، والكمية
                </p>
              </div>
              <span className="rounded-md bg-secondary px-2 py-0.5 text-[11px] font-bold tabular-nums text-foreground">
                {dataLines.length}
              </span>
            </div>
            <button
              type="button"
              onClick={appendRowAndFocus}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-xs font-bold text-primary-foreground shadow-sm transition hover:opacity-90"
            >
              <Plus className="h-3.5 w-3.5" />
              إضافة بند
            </button>
          </header>
          <div className="space-y-3 p-3">
            {lines.map((l, i) => (
              <SaleLineCard
                key={l.id}
                line={l}
                index={i}
                isLast={i === lines.length - 1}
                isUSD={isUSD}
                currency={currency}
                fabricRef={(el) => {
                  fabricRefs.current[l.id] = el;
                }}
                allLines={lines}
                onUpdate={(patch) => updateLine(l.id, patch)}
                onRemove={() => removeLine(l.id)}
                onPickFabric={(fid) => {
                  const f = fabricById(fid);
                  if (f)
                    updateLine(l.id, {
                      fabricId: f.id,
                      fabricName: f.name,
                      colorId: "",
                      colorName: "",
                      colorCode: "",
                      rollId: "",
                    });
                }}
                onPickColor={(cid) => {
                  const c = colorById(cid);
                  if (c)
                    updateLine(l.id, {
                      colorId: c.id,
                      colorName: c.name,
                      colorCode: c.code,
                      rollId: "",
                    });
                }}
                onAppend={appendRowAndFocus}
                onAddColor={() => addColorForSameFabric(l.id)}
              />
            ))}
            <button
              type="button"
              onClick={appendRowAndFocus}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border py-2.5 text-xs font-semibold text-muted-foreground transition hover:border-primary hover:bg-primary/5 hover:text-primary"
            >
              <Plus className="h-4 w-4" />
              إضافة بند جديد
              <span className="text-[10px] font-normal text-muted-foreground/70">
                (أو اضغط Enter في آخر خانة)
              </span>
            </button>
          </div>
          {dataLines.length > 0 && (
            <div className="flex items-center justify-between gap-3 border-t border-border bg-secondary/40 px-4 py-2 text-xs font-semibold">
              <span className="text-muted-foreground">
                {dataLines.length} بند • {formatNumber(totalQty)} كغ
              </span>
              <span className={cn("text-sm font-bold tabular-nums", moneyClass)}>
                {formatMoney(subtotal)} {currencySymbol(currency)}
              </span>
            </div>
          )}
        </section>

        <section className="rounded-lg border border-border bg-card">
          <div className="grid gap-2 p-2 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,0.9fr)_minmax(0,0.8fr)_minmax(0,0.9fr)]">
            <HeaderField label="العميل *">
              <div className="flex gap-1">
                <div className="min-w-0 flex-1">
                  <Select value={customerId} onValueChange={setCustomerId}>
                    <SelectTrigger className="!h-9">
                      <SelectValue placeholder="اختر العميل" />
                    </SelectTrigger>
                    <SelectContent>
                      {customers.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
                <Button
                  type="button"
                  variant="outline"
                  className="h-9 shrink-0 px-2"
                  onClick={() => setQuickCustomer(true)}
                  title="عميل جديد سريع"
                >
                  <UserPlus className="h-4 w-4" />
                </Button>
              </div>
            </HeaderField>
            <HeaderField label="رقم المرجعية">
              <Input
                className="h-9 tabular-nums"
                value={reference}
                onChange={(e) => setReference(e.target.value)}
                placeholder={invoiceNo}
              />
            </HeaderField>
            <HeaderField label="التاريخ">
              <Input
                type="date"
                className="h-9 tabular-nums"
                value={date}
                onChange={(e) => setDate(e.target.value)}
              />
            </HeaderField>
            <HeaderField label="العملة *">
              <Select value={currency} onValueChange={(v) => setCurrency(v as Currency)}>
                <SelectTrigger className={cn("!h-9", isUSD && "text-success font-bold")}>
                  <SelectValue placeholder="اختر العملة" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="SYP">ل.س</SelectItem>
                  <SelectItem value="USD">$ USD</SelectItem>
                </SelectContent>
              </Select>
            </HeaderField>
            <HeaderField label="الدفع">
              <Select value={paymentMethod} onValueChange={setPaymentMethod}>
                <SelectTrigger className="!h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {enabledPaymentMethods.map((m) => (
                    <SelectItem key={m.id} value={m.name}>
                      {m.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </HeaderField>
          </div>
          <div className="grid gap-2 border-t border-border/70 bg-secondary/20 p-2 md:grid-cols-[minmax(0,0.4fr)_minmax(0,1.6fr)]">
            <HeaderField label="المستودع">
              <Select value={warehouse} onValueChange={setWarehouse}>
                <SelectTrigger className="!h-9">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {warehousesList.map((w) => (
                    <SelectItem key={w.id} value={w.id}>
                      {w.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </HeaderField>
            <HeaderField label="ملاحظات الفاتورة">
              <Input
                className="h-9"
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                placeholder="مثال: يتم التسليم على دفعتين..."
              />
            </HeaderField>
          </div>
          {customer && (customer.phone || customer.email) && (
            <div className="flex flex-wrap items-center gap-x-3 border-t border-border/70 bg-secondary/30 px-3 py-1 text-[11px] text-muted-foreground">
              <span className="font-semibold text-foreground">{customer.name}</span>
              {customer.phone && (
                <span dir="ltr" className="tabular-nums">
                  {customer.phone}
                </span>
              )}
              {customer.email && <span>{customer.email}</span>}
            </div>
          )}
        </section>

        <section
          className={cn(
            "rounded-lg border",
            isUSD ? "border-success/40 bg-success/[0.04]" : "border-primary/30 bg-primary/[0.03]",
          )}
        >
          <div className="grid gap-x-4 gap-y-2 px-3 py-2 sm:grid-cols-3">
            <TotalCell label="الكمية" value={`${formatNumber(totalQty)} كغ`} />
            <TotalInputCell
              label="الخصم"
              value={discount}
              onChange={setDiscount}
              suffix={currencySymbol(currency)}
              tone={moneyClass}
            />
            <TotalInputCell
              label="الضريبة"
              value={tax}
              onChange={setTax}
              suffix={currencySymbol(currency)}
              tone={moneyClass}
            />
          </div>
          <div className="grid gap-x-4 gap-y-2 border-t border-border/60 px-3 py-3 sm:grid-cols-3">
            <TotalCell
              label="السعر"
              value={`${formatMoney(subtotal)} ${currencySymbol(currency)}`}
              tone={moneyClass}
            />
            <MoneyInputCell
              label="المدفوع"
              value={paid}
              onChange={setPaid}
              suffix={currencySymbol(currency)}
              tone={moneyClass}
            />
            <TotalCell
              label="المتبقي"
              value={`${formatMoney(remaining)} ${currencySymbol(currency)}`}
              tone={remaining > 0 ? "text-destructive" : moneyClass}
            />
          </div>
          <div
            className={cn(
              "flex flex-wrap items-center justify-between gap-3 border-t border-border/60 bg-card/50 px-3 py-2",
              isUSD ? "border-success/20" : "border-primary/15",
            )}
          >
            <span
              className={cn(
                "text-[10px] font-bold uppercase tracking-[0.14em]",
                isUSD ? "text-success" : "text-primary",
              )}
            >
              الإجمالي
            </span>
            <span
              className={cn(
                "text-xl font-black leading-tight tabular-nums",
                isUSD ? "text-success" : "text-foreground",
              )}
            >
              {formatMoney(netTotal)}{" "}
              <span className="text-sm font-medium text-muted-foreground">
                {currencySymbol(currency)}
              </span>
            </span>
          </div>
        </section>
        {error && (
          <div className="rounded-lg border border-destructive/40 bg-destructive/10 px-4 py-2 text-sm font-medium text-destructive">
            {error}
          </div>
        )}
      </div>
      <DocumentFooter
        onSave={() => save(false)}
        onSaveAndPrint={() => save(true)}
        onSaveAndNew={() => save(false, true)}
        onCancel={() => history.back()}
        saveLabel="حفظ الفاتورة"
        extra={
          <span className="hidden text-xs text-muted-foreground tabular-nums sm:inline">
            {dataLines.length} بند • الإجمالي:{" "}
            <span className={cn("font-semibold", moneyClass)}>
              {formatMoney(netTotal)} {currencySymbol(currency)}
            </span>
          </span>
        }
      />
      <QuickCustomerDialog
        open={quickCustomer}
        onClose={() => setQuickCustomer(false)}
        onCreated={(id) => {
          setCustomerId(id);
          setQuickCustomer(false);
        }}
      />
    </AppShell>
  );
}
