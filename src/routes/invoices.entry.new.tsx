import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Info, Package, Plus, Trash2 } from "lucide-react";
import { AppShell } from "@/components/layout/AppShell";
import { InvoiceHeader } from "@/components/invoices/InvoiceHeader";
import { ExitWithoutSavingButton } from "@/components/invoices/ExitWithoutSaving";
import { SupplierInlineCombobox } from "@/components/invoices/SupplierInlineCombobox";
import { InlineFabricCell } from "@/components/invoices/InlineFabricCell";
import { AddFabricModal, type NewFabricPayload } from "@/components/invoices/AddFabricModal";
import {
  addColor,
  addFabric,
  addRoll,
  colorByCode,
  colorById,
  fabricById,
  fabricByName,
  rollById,
  useInventory,
} from "@/presentation/hooks/useInventory";
import { supplierById } from "@/presentation/hooks/useParties";
import { currencySymbol } from "@/presentation/hooks/useCurrency";
import type { Currency } from "@/domain/types";
import { useCreateInvoice, nextInvoiceNumber } from "@/presentation/hooks/useInvoices";
import { printDocument } from "@/components/print/printPortal";
import { InvoicePrintDocument } from "@/components/print/InvoicePrintDocument";
import { useSettings } from "@/presentation/hooks/useSettings";
import { DocumentFooter } from "@/components/layout/DocumentFooter";
import { useDocumentShortcuts } from "@/hooks/use-document-shortcuts";
import { showError, showSuccess } from "@/components/common/toast-helpers";
import { cn } from "@/lib/utils";
import { ColorSearchCell } from "@/components/invoices/ColorSearchCell";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  HeaderField,
  CardField,
  GroupSection,
  TotalCell,
  TotalInputCell,
} from "@/components/invoices/InvoiceFormLayout";
import {
  type EntryLine,
  emptyLine,
  cloneStickyFields,
  lineHasData,
  lineSubtotal,
} from "@/components/invoices/entry-types";
import { useInvoice } from "@/presentation/hooks/useInvoices";
import { parseLineDetails } from "@/components/print/invoices/lineDetails";

export const Route = createFileRoute("/invoices/entry/new")({
  validateSearch: (search: Record<string, unknown>): { edit?: string } => ({
    edit: typeof search.edit === "string" ? search.edit : undefined,
  }),
  component: EntryInvoicePage,
});

// Map Arabic payment-method labels (from settings) to backend enum values.
function mapPaymentMethod(method: string): "cash" | "transfer" | "check" | "card" {
  const m = method.toLowerCase();
  if (m.includes("transfer") || m.includes("تحويل") || m.includes("حوالة")) return "transfer";
  if (m.includes("check") || m.includes("cheque") || m.includes("شيك")) return "check";
  if (m.includes("card") || m.includes("بطاقة") || m.includes("كارد")) return "card";
  return "cash";
}

function EntryInvoicePage() {
  useInventory();
  const navigate = useNavigate();
  const create = useCreateInvoice();
  const { edit } = Route.useSearch();
  const { data: editInvoice } = useInvoice(edit ?? "");

  const [supplierId, setSupplierId] = useState("");
  const [currency, setCurrency] = useState<Currency>("SYP");
  const [date, setDate] = useState<string>(new Date().toISOString().slice(0, 10));
  const settingsSnap = useSettings();
  const enabledPaymentMethods = settingsSnap.paymentMethods.filter((m) => m.enabled);
  const [paymentMethod, setPaymentMethod] = useState<string>(
    enabledPaymentMethods[0]?.name ?? "نقدي",
  );
  const [reference, setReference] = useState("");
  const invoiceNo = useMemo(() => nextInvoiceNumber("entry"), []);

  // Always keep a trailing empty row so operator can type immediately.
  const [lines, setLines] = useState<EntryLine[]>(() => [emptyLine()]);
  const [discount, setDiscount] = useState<number | "">("");
  const [tax, setTax] = useState<number | "">("");
  const [shipping, setShipping] = useState<number | "">("");
  const [paid, setPaid] = useState<number | "">("");
  const [error, setError] = useState<string | null>(null);

  // Per-field validation flags — "lineId:field" → red border on the bad cell.
  // Cleared on every save attempt and re-populated when validation fails.
  const [invalidFields, setInvalidFields] = useState<Set<string>>(new Set());
  const clearInvalid = () => setInvalidFields(new Set());
  const flagInvalid = (lineId: string, field: string) => {
    setInvalidFields((prev) => {
      const next = new Set(prev);
      next.add(`${lineId}:${field}`);
      return next;
    });
  };
  const fieldHasError = (lineId: string, field: string) => invalidFields.has(`${lineId}:${field}`);
  const invalidCls = "border-destructive/60 ring-1 ring-destructive/30 bg-destructive/[0.04]";

  // Optional "more details" modal for a specific row (reuses existing 5-section form).
  const [detailsOpenForLine, setDetailsOpenForLine] = useState<string | null>(null);

  // Focus refs — first editable cell of each row is the fabric input.
  const fabricRefs = useRef<Record<string, HTMLInputElement | null>>({});

  const dataLines = lines.filter(lineHasData);
  const subtotal = dataLines.reduce((s, l) => s + lineSubtotal(l), 0);
  const totalQty = dataLines.reduce((s, l) => s + (l.quantity || 0), 0);
  const grandTotal =
    subtotal - (Number(discount) || 0) + (Number(tax) || 0) + (Number(shipping) || 0);

  const isUSD = currency === "USD";
  const moneyClass = isUSD ? "text-success" : "text-foreground";

  // When arriving with ?edit=<invoiceId>, pre-fill the form from that invoice
  // so the user can correct it and save a new copy (no backend PUT exists).
  useEffect(() => {
    if (!edit || !editInvoice) return;
    setSupplierId(editInvoice.partyId);
    setCurrency(editInvoice.currency as Currency);
    setDate(editInvoice.date);
    setDiscount(editInvoice.discount ?? "");
    setTax(editInvoice.tax ?? "");

    const mapped: EntryLine[] = editInvoice.lines.map((l) => {
      const fab = fabricById(l.fabricId);
      const col = colorById(l.colorId);
      const roll = rollById(l.rollId);
      const line: EntryLine = {
        ...emptyLine(),
        existingFabricId: fab?.id,
        existingColorId: col?.id,
        fabricName: fab?.name ?? "",
        category: fab?.category ?? "",
        unit: (fab?.unit ?? "kg") as EntryLine["unit"],
        colorName: col?.name ?? "",
        colorCode: col?.code ?? "",
        colorHex: col?.hex ?? undefined,
        quantity: l.quantityKg,
        pricePerKg: l.pricePerKg,
        discountAmount: l.discountAmount ?? 0,
      };
      // Re-hydrate the "extra details" fields from the line note (if any).
      if (l.note) {
        const parsed = parseLineDetails(l.note);
        for (const d of parsed.details) {
          const v = d.value;
          if (d.label.includes("مرجعية")) line.marjaiya = v;
          else if (d.label.includes("مصدر")) line.masader = v;
          else if (d.label.includes("الماكينة")) line.machineNumber = v;
          else if (d.label.includes("كرماج")) line.kromaj = v;
          else if (d.label.includes("GSM")) line.gsm = v;
          else if (d.label.includes("العدد")) line.adad = v;
          else if (d.label.includes("السحب")) line.sahb = v;
          else if (d.label.includes("قائم")) line.grossKg = Number(v) || 0;
        }
      }
      line.notes = roll?.rollNo ? `رقم الصبغة: ${roll.rollNo}` : undefined;
      return line;
    });
    setLines(mapped.length > 0 ? mapped : [emptyLine()]);
  }, [edit, editInvoice]);

  const removeLine = (id: string) => {
    setLines((p) => {
      const next = p.filter((x) => x.id !== id);
      return next.length === 0 ? [emptyLine()] : next;
    });
  };

  const updateLine = (id: string, patch: Partial<EntryLine>) =>
    setLines((p) => p.map((l) => (l.id === id ? { ...l, ...patch } : l)));

  const pickExistingFabric = (id: string, fabricId: string) => {
    const f = fabricById(fabricId);
    if (!f) return;
    updateLine(id, {
      existingFabricId: f.id,
      fabricName: f.name,
      category: f.category ?? "",
      unit: f.unit ?? "kg",
      // reset any previously-typed color when fabric changes
      existingColorId: undefined,
      colorName: "",
      colorCode: "",
    });
  };
  const pickExistingColorObj = (
    id: string,
    c: { id: string; name: string; code: string; hex?: string | null; imageUrl?: string | null },
  ) => {
    updateLine(id, {
      existingColorId: c.id,
      colorName: c.name,
      colorCode: c.code,
      colorHex: c.hex ?? undefined,
      colorImageUrl: c.imageUrl ?? undefined,
    });
  };

  const appendRowAndFocus = () => {
    // Prefill sticky fields from the last non-empty row so operator only
    // enters what changes per roll: weight + dye batch.
    const dataRows = lines.filter(lineHasData);
    const last = dataRows[dataRows.length - 1];
    const row: EntryLine = last ? { ...emptyLine(), ...cloneStickyFields(last) } : emptyLine();
    setLines((p) => [...p, row]);
    setTimeout(() => fabricRefs.current[row.id]?.focus(), 0);
  };

  const isLastRow = (id: string) => lines[lines.length - 1]?.id === id;

  // Enter on the last cell (masader) of the last row appends a new row.
  const handleRowEnd = (e: KeyboardEvent<HTMLInputElement>, id: string) => {
    if (e.key !== "Enter") return;
    e.preventDefault();
    if (isLastRow(id)) {
      appendRowAndFocus();
    } else {
      const idx = lines.findIndex((l) => l.id === id);
      const next = lines[idx + 1];
      if (next) fabricRefs.current[next.id]?.focus();
    }
  };

  // Inject data from the (optional) full-form modal into the associated row.
  const applyDetailsPayload = (rowId: string, payload: NewFabricPayload) => {
    updateLine(rowId, {
      existingFabricId: payload.fabricId,
      existingColorId: payload.colorId,
      fabricName: payload.fabricName,
      unit: payload.unit,
      colorName: payload.colorName,
      colorCode: payload.colorCode,
      imageUrl: payload.imageUrl,
      dyeBatch: payload.dyeBatch,
      widthCm: payload.widthCm,
      weightGsm: payload.weightGsm,
      quantity: payload.quantityKg,
      pricePerKg: payload.pricePerKg,
      salePricePerKg: payload.salePricePerKg,
    });
  };

  const resetForm = () => {
    setSupplierId("");
    setLines([emptyLine()]);
    setDiscount("");
    setTax("");
    setShipping("");
    setReference("");
    setError(null);
  };

  const save = async (thenPrint: boolean, thenNew = false) => {
    setError(null);
    clearInvalid();

    // ── Validate header ────────────────────────────────────────────
    if (!supplierId) {
      setError("يرجى تحديد المورد.");
      showError("حقل المورد فارغ — الرجاء اختيار مورد قبل الحفظ");
      return;
    }
    const rows = lines.filter(lineHasData);
    if (rows.length === 0) {
      setError("أضف على الأقل بنداً واحداً إلى الفاتورة.");
      showError("الفاتورة فارغة — أضف صبغة واحدة على الأقل");
      return;
    }

    // ── Validate every line, collect flags for visual feedback ────
    for (const l of rows) {
      let bad = false;
      if (!l.fabricName.trim()) {
        flagInvalid(l.id, "fabricName");
        bad = true;
      }
      if (!l.colorName.trim()) {
        flagInvalid(l.id, "colorName");
        bad = true;
      }
      if (l.quantity <= 0) {
        flagInvalid(l.id, "quantity");
        bad = true;
      }
      // DB precision guard: rolls.initial_kg / price_per_kg are decimal(12,2)
      // (max 9,999,999,999.99) and roll schema caps initialKg at 100,000 kg.
      // Reject oversized values up-front so the backend never fails with a
      // confusing "numeric field overflow" after the roll was already created.
      if (l.quantity > 100000) {
        flagInvalid(l.id, "quantity");
        setError(`وزن الصبغة كبير جداً — الحد الأقصى 100,000 كغ.`);
        showError(`وزن الصبغة كبير جداً — الحد الأقصى 100,000 كغ`);
        return;
      }
      if (l.pricePerKg > 9_999_999_999) {
        flagInvalid(l.id, "pricePerKg");
        setError(`سعر الكيلو كبير جداً — الحد الأقصى 9,999,999,999.`);
        showError(`سعر الكيلو كبير جداً — الحد الأقصى 9,999,999,999`);
        return;
      }
      if (l.salePricePerKg != null && l.salePricePerKg > 9_999_999_999) {
        flagInvalid(l.id, "pricePerKg");
        setError(`سعر البيع كبير جداً — الحد الأقصى 9,999,999,999.`);
        showError(`سعر البيع كبير جداً — الحد الأقصى 9,999,999,999`);
        return;
      }
      if (l.pricePerKg <= 0) {
        flagInvalid(l.id, "pricePerKg");
        bad = true;
      }
      if (bad) {
        const label = l.fabricName.trim() || `سطر #${rows.indexOf(l) + 1}`;
        setError(`حقول ناقصة على قماش "${label}".`);
        showError(`حقول ناقصة على قماش "${label}" — اسم/لون/وزن/سعر`);
        return;
      }
    }

    // ── Persist side-effects: new fabrics, colors, rolls ───────────
    let newFabrics = 0;
    let newColors = 0;
    const createdRollIds: string[] = [];
    const createdRollNos: string[] = [];
    let totalKg = 0;

    const invLines = [];
    try {
      for (const l of rows) {
        let fabricId = l.existingFabricId;
        let colorId = l.existingColorId;
        if (!fabricId) {
          const existing = fabricByName(l.fabricName.trim());
          if (existing) {
            fabricId = existing.id;
          } else {
            const fab = await addFabric(
              {
                name: l.fabricName.trim(),
                category: l.category,
                minStockKg: 10,
                notes: l.notes,
                unit: l.unit,
                imageUrl: l.imageUrl ?? undefined,
              },
              { silent: true },
            );
            fabricId = fab.id;
            newFabrics += 1;
          }
        }
        if (!colorId) {
          const codeKey = l.colorCode.trim();
          // Fix C-11: fabricId is resolved above (existing or just
          // created) before we ever look up a color code — pass it so the
          // lookup can never merge into a same-code color under a
          // different fabric.
          const existingColor = codeKey ? colorByCode(codeKey, fabricId) : undefined;
          if (existingColor) {
            colorId = existingColor.id;
          } else {
            const col = await addColor(
              {
                fabricId,
                name: l.colorName.trim(),
                code: codeKey || `C-${Date.now().toString().slice(-3)}`,
                hex: l.colorHex ?? undefined,
                imageUrl: l.colorImageUrl ?? undefined,
              },
              { silent: true },
            );
            colorId = col.id;
            newColors += 1;
          }
        }
        const rowNotes = [
          l.marjaiya ? `مرجعية: ${l.marjaiya}` : "",
          l.masader ? `مصدر: ${l.masader}` : "",
          l.machineNumber ? `رقم الماكينة: ${l.machineNumber}` : "",
          l.kromaj ? `كراماج: ${l.kromaj}` : "",
          l.gsm ? `GSM: ${l.gsm}` : "",
          l.adad ? `العدد: ${l.adad}` : "",
          l.sahb ? `السحب: ${l.sahb}` : "",
          l.grossKg ? `وزن قائم: ${l.grossKg}` : "",
          l.notes || "",
        ]
          .filter(Boolean)
          .join(" • ");
        const roll = await addRoll(
          {
            colorId,
            rollNo: `R-${Date.now().toString().slice(-5)}-${l.id.slice(-2)}`,
            dyeBatch: l.dyeBatch,
            initialKg: l.quantity,
            // The entry invoice transaction increments remainingKg from 0 to
            // quantity — passing 0 here keeps the stock count accurate without
            // double-counting against the invoice's stock increment.
            remainingKg: 0,
            pricePerKg: l.pricePerKg,
            salePricePerKg: l.salePricePerKg,
            currency,
            supplierId,
            entryDate: date,
            widthCm: l.widthCm,
            weightGsm: l.weightGsm,
          },
          { silent: true },
        );
        createdRollIds.push(roll.id);
        createdRollNos.push(roll.rollNo);
        totalKg += l.quantity;
        invLines.push({
          id: `il-${roll.id}`,
          fabricId,
          colorId,
          rollId: roll.id,
          quantityKg: l.quantity,
          pricePerKg: l.pricePerKg,
          discountAmount: Math.round(l.discountAmount ?? 0),
          note: rowNotes || undefined,
        });
      }
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : "خطأ في إنشاء عناصر المخزون";
      setError(errMsg);
      showError(errMsg);
      return;
    }

    const advParts = [
      reference && `المرجع: ${reference}`,
      paymentMethod && `طريقة الدفع: ${paymentMethod}`,
    ].filter(Boolean);

    const paidAmount = paid === "" ? 0 : Number(paid);
    // Guard against overpaying — show a clear Arabic error instead of letting
    // the backend reject with a confusing "Paid amount exceeds invoice total".
    const netTotal = grandTotal;
    if (paidAmount > netTotal) {
      const msg = `المبلغ المدفوع (${paidAmount}) أكبر من الإجمالي الكلي للفاتورة (${Math.round(netTotal)}).`;
      setError(msg);
      showError(msg);
      return;
    }
    const res = await create.mutateAsync({
      tenantId: "dev-tenant",
      number: nextInvoiceNumber("entry"),
      type: "entry",
      date,
      partyId: supplierId,
      partyType: "supplier",
      currency,
      discount: Number(discount) || 0,
      tax: Number(tax) || 0,
      shipping: Number(shipping) || 0,
      lines: invLines,
      notes: advParts.join(" • "),
      paid: paidAmount > 0 ? paidAmount : undefined,
      paymentMethod: paidAmount > 0 ? mapPaymentMethod(paymentMethod) : undefined,
    });

    if (!res.ok) {
      const msg =
        typeof (res as any).error === "string"
          ? (res as any).error
          : ((res as any).error?.message ?? "فشل إنشاء الفاتورة");
      setError(msg);
      showError(msg);
      return;
    }
    const inv = res.value;

    // ── Success — toast + inventory impact summary ────────────────
    const impactParts: string[] = [];
    impactParts.push(
      `أُضيف ${createdRollIds.length} صبغة (${totalKg.toLocaleString("en-US")} كغ) إلى المخزون`,
    );
    if (newFabrics > 0) impactParts.push(`+${newFabrics} قماش جديد`);
    if (newColors > 0) impactParts.push(`+${newColors} لون جديد`);
    showSuccess(`تم حفظ فاتورة الدخول رقم ${inv.number} — ${impactParts.join(" • ")}`);

    if (thenPrint) printDocument(<InvoicePrintDocument invoice={inv} />);
    if (thenNew) {
      resetForm();
      return;
    }
    navigate({ to: "/invoices/$id", params: { id: inv.id } });
  };

  const supplier = supplierId ? supplierById(supplierId) : undefined;

  useDocumentShortcuts({
    onSave: () => save(false),
    onNew: () => resetForm(),
  });

  return (
    <AppShell>
      <div className="mx-auto w-full max-w-[1400px] space-y-2 pb-24">
        <InvoiceHeader
          variant="entry"
          invoiceNumber={invoiceNo}
          date={date}
          status={dataLines.length === 0 ? "مسودة" : "جاهزة للحفظ"}
          actions={<ExitWithoutSavingButton />}
        />

        {/* Header row — 5 fields, supplier now inline-searchable + inline-create */}
        <section className="rounded-lg border border-border bg-card">
          <div className="grid gap-2 p-2 md:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,0.9fr)_minmax(0,0.8fr)_minmax(0,0.9fr)]">
            <HeaderField label="المورد *">
              <SupplierInlineCombobox value={supplierId} onChange={setSupplierId} />
            </HeaderField>
            <HeaderField label="رقم الفاتورة">
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
            <HeaderField label="العملة">
              <Select value={currency} onValueChange={(v) => setCurrency(v as Currency)}>
                <SelectTrigger className={cn("!h-9", isUSD && "text-success font-bold")}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="SYP">ل.س</SelectItem>
                  <SelectItem value="USD">$ USD</SelectItem>
                </SelectContent>
              </Select>
            </HeaderField>
            <HeaderField label="الدفع">
              <Select value={paymentMethod} onValueChange={(v) => setPaymentMethod(v)}>
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
          {supplier && (supplier.code || supplier.city || supplier.phone) && (
            <div className="flex flex-wrap items-center gap-x-3 border-t border-border/70 bg-secondary/30 px-3 py-1 text-[11px] text-muted-foreground">
              {supplier.code && <span className="font-mono tabular-nums">{supplier.code}</span>}
              {supplier.city && <span>{supplier.city}</span>}
              {supplier.phone && (
                <span dir="ltr" className="tabular-nums">
                  {supplier.phone}
                </span>
              )}
            </div>
          )}
        </section>

        {/* ── Roll Cards ───────────────────────────────────────────── */}
        <section className="rounded-xl border border-border bg-card shadow-soft">
          <header className="flex flex-wrap items-center justify-between gap-2 border-b border-border px-4 py-2.5">
            <div className="flex items-center gap-2">
              <div className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                <Package className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <h2 className="text-sm font-bold text-foreground">الصبغات</h2>
                <p className="text-[11px] text-muted-foreground">
                  أضف كل صبغة كبطاقة مستقلة — بيانات القماش، اللون، الوزن والسعر
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
              إضافة صبغة
            </button>
          </header>

          <div className="space-y-3 p-3">
            {lines.map((l, i) => {
              const rowIsEmpty = !lineHasData(l);
              return (
                <article
                  key={l.id}
                  className={cn(
                    "group rounded-lg border bg-background/60 transition",
                    rowIsEmpty
                      ? "border-dashed border-primary/30 bg-primary/[0.02]"
                      : "border-border hover:border-primary/40 hover:shadow-sm",
                  )}
                >
                  {/* Card header */}
                  <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-1.5">
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          "grid h-6 min-w-[28px] place-items-center rounded-md px-2 text-[11px] font-bold tabular-nums",
                          rowIsEmpty
                            ? "bg-primary/10 text-primary"
                            : "bg-primary text-primary-foreground",
                        )}
                      >
                        {i + 1}
                      </span>
                      <span className="text-xs font-semibold text-foreground">
                        الصبغة رقم {i + 1}
                        {!rowIsEmpty && l.fabricName && (
                          <span className="mr-1.5 font-normal text-muted-foreground">
                            — {l.fabricName}
                            {l.colorName && ` / ${l.colorName}`}
                          </span>
                        )}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      {!rowIsEmpty && (
                        <span
                          className={cn(
                            "text-xs font-bold tabular-nums",
                            isUSD ? "text-success" : "text-foreground",
                          )}
                        >
                          {Math.round(lineSubtotal(l)).toLocaleString("en-US")}{" "}
                          <span className="text-[10px] font-medium text-muted-foreground">
                            {currencySymbol(currency)}
                          </span>
                        </span>
                      )}
                      <button
                        type="button"
                        onClick={() => setDetailsOpenForLine(l.id)}
                        className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition hover:bg-primary/10 hover:text-primary"
                        aria-label="تفاصيل إضافية"
                        title="تفاصيل إضافية للقماش"
                      >
                        <Info className="h-3.5 w-3.5" />
                      </button>
                      {!rowIsEmpty && (
                        <button
                          type="button"
                          onClick={() => removeLine(l.id)}
                          className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition hover:bg-destructive/10 hover:text-destructive"
                          aria-label="حذف الصبغة"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Card body — grouped sections */}
                  <div className="space-y-2 p-3">
                    {/* ── بيانات القماش ── */}
                    <GroupSection title="بيانات القماش">
                      <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
                        <CardField label="نوع القماش" required>
                          <InlineFabricCell
                            ref={(el) => {
                              fabricRefs.current[l.id] = el;
                            }}
                            value={l.fabricName}
                            existingFabricId={l.existingFabricId}
                            className={fieldHasError(l.id, "fabricName") ? invalidCls : undefined}
                            onPickExisting={(fid) => pickExistingFabric(l.id, fid)}
                            onSetName={(name) =>
                              updateLine(l.id, {
                                fabricName: name,
                                existingFabricId: undefined,
                              })
                            }
                          />
                        </CardField>
                        <CardField label="المرجعية">
                          <Input
                            value={l.marjaiya}
                            onChange={(e) => updateLine(l.id, { marjaiya: e.target.value })}
                            className="h-9"
                            placeholder="—"
                            aria-label="المرجعية"
                          />
                        </CardField>
                        <CardField label="المصدر">
                          <Input
                            value={l.masader}
                            onChange={(e) => updateLine(l.id, { masader: e.target.value })}
                            className="h-9"
                            placeholder="—"
                            aria-label="المصدر"
                          />
                        </CardField>
                      </div>
                    </GroupSection>

                    {/* ── بيانات الإنتاج ── */}
                    <GroupSection title="بيانات الإنتاج">
                      <div className="grid grid-cols-2 gap-2 md:grid-cols-2">
                        <CardField label="رقم الماكينة">
                          <Input
                            value={l.machineNumber}
                            onChange={(e) => updateLine(l.id, { machineNumber: e.target.value })}
                            className="h-9"
                            placeholder="—"
                            aria-label="رقم الماكينة"
                          />
                        </CardField>
                        <CardField label="كراماج">
                          <Input
                            value={l.kromaj}
                            onChange={(e) => updateLine(l.id, { kromaj: e.target.value })}
                            className="h-9"
                            placeholder="—"
                            aria-label="كراماج"
                          />
                        </CardField>
                        <CardField label="العدد">
                          <Input
                            value={l.adad}
                            onChange={(e) => updateLine(l.id, { adad: e.target.value })}
                            className="h-9 tabular-nums"
                            placeholder="—"
                            aria-label="العدد"
                          />
                        </CardField>
                        <CardField label="السحب">
                          <Input
                            value={l.sahb}
                            onChange={(e) => updateLine(l.id, { sahb: e.target.value })}
                            className="h-9 tabular-nums"
                            placeholder="—"
                            aria-label="السحب"
                          />
                        </CardField>
                      </div>
                    </GroupSection>

                    {/* ── بيانات اللون ── */}
                    <GroupSection title="بيانات اللون">
                      <ColorSearchCell
                        name={l.colorName}
                        code={l.colorCode}
                        hex={l.colorHex}
                        existingColorId={l.existingColorId}
                        imageUrl={l.colorImageUrl}
                        fabricId={l.existingFabricId}
                        onPickExisting={(c) => pickExistingColorObj(l.id, c)}
                        onSetName={(v) =>
                          updateLine(l.id, {
                            colorName: v,
                            existingColorId: undefined,
                          })
                        }
                        onSetCode={(v) =>
                          updateLine(l.id, {
                            colorCode: v,
                            existingColorId: undefined,
                          })
                        }
                        onSetHex={(hex) => updateLine(l.id, { colorHex: hex })}
                        onSetImage={(url) => updateLine(l.id, { colorImageUrl: url })}
                      />
                    </GroupSection>

                    {/* ── بيانات الوزن ── */}
                    <GroupSection title="بيانات الوزن">
                      <div className="grid grid-cols-2 gap-2 md:grid-cols-2">
                        <CardField label="الوزن القائم (كغ)">
                          <Input
                            type="number"
                            value={l.grossKg || ""}
                            onChange={(e) =>
                              updateLine(l.id, {
                                grossKg: e.target.value === "" ? 0 : Number(e.target.value),
                              })
                            }
                            className="h-9 text-left tabular-nums"
                            placeholder="0"
                            aria-label="الوزن القائم"
                          />
                        </CardField>
                        <CardField label="الوزن الصافي (كغ)" required>
                          <Input
                            type="number"
                            value={l.quantity || ""}
                            onChange={(e) =>
                              updateLine(l.id, {
                                quantity: e.target.value === "" ? 0 : Number(e.target.value),
                              })
                            }
                            className="h-9 text-left tabular-nums"
                            placeholder="0"
                            aria-label="الوزن الصافي"
                          />
                        </CardField>
                      </div>
                    </GroupSection>

                    {/* ── بيانات الصباغة ── */}
                    <GroupSection title="بيانات الصباغة">
                      <div className="grid grid-cols-1 gap-2">
                        <CardField label="رقم الصبغة">
                          <Input
                            value={l.dyeBatch}
                            onChange={(e) => updateLine(l.id, { dyeBatch: e.target.value })}
                            className="h-9 tabular-nums"
                            placeholder="DY-…"
                            aria-label="رقم الصبغة"
                          />
                        </CardField>
                      </div>
                    </GroupSection>

                    {/* ── بيانات الشراء ── */}
                    <GroupSection title="بيانات الشراء">
                      <div className="grid grid-cols-2 gap-2 md:grid-cols-3">
                        <CardField label={`السعر / كغ (${currencySymbol(currency)})`} required>
                          <Input
                            type="number"
                            value={l.pricePerKg || ""}
                            onChange={(e) =>
                              updateLine(l.id, {
                                pricePerKg: e.target.value === "" ? 0 : Number(e.target.value),
                              })
                            }
                            className={cn(
                              "h-9 text-left tabular-nums",
                              isUSD && "text-success font-semibold",
                            )}
                            placeholder="0"
                            aria-label="سعر الوحدة"
                          />
                        </CardField>
                        <CardField label="الخصم">
                          <Input
                            type="number"
                            min={0}
                            step={1}
                            value={l.discountAmount || ""}
                            onChange={(e) =>
                              updateLine(l.id, {
                                discountAmount: e.target.value === "" ? 0 : Math.round(Number(e.target.value)),
                              })
                            }
                            onKeyDown={(e) => handleRowEnd(e, l.id)}
                            className="h-9 text-left tabular-nums"
                            placeholder="0"
                            aria-label="الخصم"
                          />
                        </CardField>
                        <div className="flex items-end justify-end">
                          <div className="flex flex-col items-end">
                            <span className="text-[10px] font-semibold uppercase tracking-wide text-muted-foreground">
                              الإجمالي
                            </span>
                            <span
                              className={cn(
                                "text-lg font-black tabular-nums leading-tight",
                                isUSD ? "text-success" : "text-foreground",
                              )}
                            >
                              {Math.round(lineSubtotal(l)).toLocaleString("en-US")}{" "}
                              <span className="text-[10px] font-medium text-muted-foreground">
                                {currencySymbol(currency)}
                              </span>
                            </span>
                          </div>
                        </div>
                      </div>
                    </GroupSection>
                  </div>
                </article>
              );
            })}

            <button
              type="button"
              onClick={appendRowAndFocus}
              className="flex w-full items-center justify-center gap-2 rounded-lg border border-dashed border-border py-2.5 text-xs font-semibold text-muted-foreground transition hover:border-primary hover:bg-primary/5 hover:text-primary"
            >
              <Plus className="h-4 w-4" />
              إضافة صبغة جديدة
              <span className="text-[10px] font-normal text-muted-foreground/70">
                (أو اضغط Enter في آخر خانة)
              </span>
            </button>
          </div>

          {dataLines.length > 0 && (
            <div className="flex items-center justify-between gap-3 border-t border-border bg-secondary/40 px-4 py-2 text-xs font-semibold">
              <span className="text-muted-foreground">
                {dataLines.length} صبغة • {totalQty.toLocaleString("en-US")} كغ
              </span>
              <span
                className={cn(
                  "text-sm font-bold tabular-nums",
                  isUSD ? "text-success" : "text-foreground",
                )}
              >
                {Math.round(subtotal).toLocaleString("en-US")} {currencySymbol(currency)}
              </span>
            </div>
          )}
        </section>

        {/* ── Totals ─────────────────────────────────────────────── */}
        <section
          className={cn(
            "rounded-lg border",
            isUSD ? "border-success/40 bg-success/[0.04]" : "border-primary/30 bg-primary/[0.03]",
          )}
        >
          <div className="grid gap-x-4 gap-y-1 px-3 py-2 sm:grid-cols-2 lg:grid-cols-6">
            <TotalCell label="الكمية" value={`${totalQty.toLocaleString("en-US")} كغ`} />
            <TotalCell
              label="المجموع"
              value={`${Math.round(subtotal).toLocaleString("en-US")} ${currencySymbol(currency)}`}
              tone={moneyClass}
            />
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
            <TotalInputCell
              label="الشحن"
              value={shipping}
              onChange={setShipping}
              suffix={currencySymbol(currency)}
              tone={moneyClass}
            />
            <TotalInputCell
              label="المدفوع"
              value={paid}
              onChange={setPaid}
              suffix={currencySymbol(currency)}
              tone={moneyClass}
            />
            <div
              className={cn(
                "flex flex-col items-end justify-center border-r pr-3",
                isUSD ? "border-success/30" : "border-primary/20",
              )}
            >
              <span
                className={cn(
                  "text-[10px] font-bold uppercase tracking-[0.14em]",
                  isUSD ? "text-success" : "text-primary",
                )}
              >
                الإجمالي الكلي
              </span>
              <span
                className={cn(
                  "text-xl font-black leading-tight tabular-nums",
                  isUSD ? "text-success" : "text-foreground",
                )}
              >
                {Math.round(grandTotal).toLocaleString("en-US")}{" "}
                <span className="text-sm font-medium text-muted-foreground">
                  {currencySymbol(currency)}
                </span>
              </span>
            </div>
          </div>
          {paid !== "" && Number(paid) > 0 && (
            <div className="flex items-center justify-end gap-2 border-t px-3 py-2 text-xs font-semibold">
              <span className="text-muted-foreground">المتبقي:</span>
              <span className={cn("tabular-nums font-bold", moneyClass)}>
                {Math.max(0, grandTotal - Number(paid)).toLocaleString("en-US")}{" "}
                {currencySymbol(currency)}
              </span>
            </div>
          )}
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
              {Math.round(grandTotal).toLocaleString("en-US")} {currencySymbol(currency)}
            </span>
          </span>
        }
      />

      {/* Optional 5-section form — reachable only via the row's "info" button.
          Not required for daily entry. Registers a new fabric + color and
          fills the row on save. */}
      <AddFabricModal
        open={detailsOpenForLine !== null}
        onOpenChange={(v) => {
          if (!v) setDetailsOpenForLine(null);
        }}
        defaultSupplierId={supplierId}
        defaultDate={date}
        onCreated={(payload) => {
          if (detailsOpenForLine) applyDetailsPayload(detailsOpenForLine, payload);
          setDetailsOpenForLine(null);
        }}
      />
    </AppShell>
  );
}
