import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { Info, Package, Palette, Plus, Trash2 } from "lucide-react";
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
  colors,
  colorsOfFabric,
  updateColor,
  fabricById,
  fabricByName,
  refreshInventory,
  rollById,
  useInventory,
} from "@/presentation/hooks/useInventory";
import { resolveColorPick } from "@/domain/inventory/colorLookup";
import { normalizeInventoryName } from "@/domain/inventory/normalizeInventoryName";
import { supplierById } from "@/presentation/hooks/useParties";
import { currencySymbol } from "@/presentation/hooks/useCurrency";
import type { Currency } from "@/domain/types";
import {
  useCreateInvoice,
  useUpdateInvoice,
  useNextInvoiceNumber,
} from "@/presentation/hooks/useInvoices";
import { invoiceSubtotal, invoiceTotal } from "@/core/calculations/invoiceCalc";
import { saneSypRateError } from "@erp/shared";
import { useSypRateSoftWarning } from "@/presentation/hooks/useSypRateSoftCheck";
import { printOrArchive } from "@/components/print/printPortal";
import { archiveMeta } from "@/shared/utils/documentArchive";
import { InvoicePrintDocument } from "@/components/print/InvoicePrintDocument";
import { useSettings } from "@/presentation/hooks/useSettings";
import { DocumentFooter } from "@/components/layout/DocumentFooter";
import { useDocumentShortcuts } from "@/hooks/use-document-shortcuts";
import { showError, showSuccess } from "@/components/common/toast-helpers";
import { buildTenantContext } from "@/infrastructure/di/auth-context";
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
  FormattedAmountInput,
  PaymentMethodSelect,
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
import { parseInvoiceNotes } from "@/components/print/noteParser";
import { formatNumber, formatMoney, formatQuantity } from "@/shared/utils/formatNumber";
import { MAX_2DP_MSG, hasMoreThan2dp } from "@/shared/utils/precision";

import { localToday } from "@/lib/localDate";
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

/* ── Field-level, human-readable validation messages. The precision constant
   (`MAX_2DP_MSG`) and `hasMoreThan2dp` live in src/shared/utils/precision.ts
   and mirror the backend's decimal(12,2) rule. ──────────────────────────── */

/** Map a backend dotted path (e.g. "lines.0.pricePerKg") to an Arabic field label. */
function fieldLabel(path: string): string {
  const p = path.toLowerCase();
  if (p.includes("priceperkg") || p === "price" || p === "priceperkg") return "السعر / كغ";
  if (p.includes("saleprice")) return "سعر البيع / كغ";
  if (p.includes("quantity") || p.includes("initialkg") || p === "weight") return "الوزن / الكمية";
  if (p.includes("discount")) return "الخصم";
  if (p.includes("note") || p.includes("notes")) return "الملاحظات";
  if (p.includes("pieces")) return "الأثواب";
  if (p.includes("paid")) return "المبلغ المدفوع";
  if (p.includes("hex")) return "قيمة اللون (hex)";
  return path;
}

/** Build one readable Arabic line from the backend's field details. */
function detailsText(details?: Record<string, string[]>, fallback = ""): string {
  if (!details) return fallback;
  return Object.entries(details)
    .map(([path, msgs]) => `${fieldLabel(path)}: ${msgs.join("، ")}`)
    .join(" • ");
}

function EntryInvoicePage() {
  // Inventory cache reactivity: useInventory() returns the cache version which
  // increments when the async fabrics/colors/rolls load completes. Captured so
  // the edit-prefill repair effect below can re-resolve names when the cache
  // arrives AFTER the invoice data (the async-load race).
  const inventoryVersion = useInventory();
  const navigate = useNavigate();
  const create = useCreateInvoice();
  const update = useUpdateInvoice({ silent: true });
  const { edit } = Route.useSearch();
  const { data: editInvoice } = useInvoice(edit ?? "");

  const [supplierId, setSupplierId] = useState("");
  const [currency, setCurrency] = useState<Currency>("SYP");
  const [date, setDate] = useState<string>(localToday());
  // FX rule (base currency = USD): a non-USD entry invoice MUST carry the
  // frozen exchange rate (units of SYP per 1 USD) captured at creation time.
  const [exchangeRate, setExchangeRate] = useState<number | "">("");
  const [softWarningAcked, setSoftWarningAcked] = useState(false);
  const enteredRateNum = Number(exchangeRate) > 0 ? Number(exchangeRate) : null;
  const softWarning = useSypRateSoftWarning(currency, enteredRateNum);
  useEffect(() => {
    setSoftWarningAcked(false);
  }, [enteredRateNum, currency]);
  const settingsSnap = useSettings();
  const enabledPaymentMethods = settingsSnap.paymentMethods.filter((m) => m.enabled);
  const [paymentMethod, setPaymentMethod] = useState<string>(
    enabledPaymentMethods[0]?.name ?? "نقدي",
  );
  const [reference, setReference] = useState("");
  // #7 preview from the server's document_sequences (estimate — real number is
  // allocated at save time and may differ under concurrency).
  const { data: previewNumber } = useNextInvoiceNumber("entry");
  // FIN-02: no client-side fabrication — the server allocates the real number.
  const invoiceNo = previewNumber ?? "…";

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
  const mathLines = dataLines.map((l) => ({
    quantityKg: l.quantity || 0,
    pricePerKg: l.pricePerKg || 0,
    discountAmount: l.discountAmount || 0,
  }));
  // FIN-01: shared money authority — identical rounding to the backend.
  const subtotal = invoiceSubtotal({ lines: mathLines });
  const totalQty = dataLines.reduce((s, l) => s + (l.quantity || 0), 0);
  const grandTotal = invoiceTotal({
    lines: mathLines,
    discount: Number(discount) || 0,
    tax: Number(tax) || 0,
    shipping: Number(shipping) || 0,
  });

  const isUSD = currency === "USD";
  const moneyClass = isUSD ? "text-success" : "text-foreground";

  // When arriving with ?edit=<invoiceId>, pre-fill the form from that invoice
  // so the user can correct the SAME invoice (backend PUT exists).
  //
  // Race fix: the mapping resolves fabric/color/roll names through the
  // module-level inventory cache, which loads ASYNCHRONOUSLY. Previously this
  // effect re-ran on every editInvoice identity change (clobbering in-progress
  // edits on refetch) yet never re-ran when the cache arrived later — so a
  // cold cache produced lines with empty names and permanently failing
  // validation ("حقول ناقصة"). Two guards now make this correct:
  //   - editPrefilledRef: one-shot prefill per edit id — a react-query refetch
  //     must never clobber the operator's edits (same protection as
  //     invoices.sale.new.tsx:118-121).
  //   - The repair effect below re-resolves the identity fields once the
  //     cache becomes available (inventoryVersion change).
  const editRawLinesRef = useRef<{ rollId: string; fabricId: string; colorId: string }[] | null>(
    null,
  );
  const editPrefilledRef = useRef<string | null>(null);
  useEffect(() => {
    if (!edit || !editInvoice) return;
    if (editPrefilledRef.current === edit) return;
    editPrefilledRef.current = edit;
    editRawLinesRef.current = editInvoice.lines.map((l) => ({
      rollId: l.rollId,
      fabricId: l.fabricId,
      colorId: l.colorId,
    }));
    setSupplierId(editInvoice.partyId);
    setCurrency(editInvoice.currency as Currency);
    setDate(editInvoice.date);
    // QA fix (Part 2): populate the frozen exchange rate from the API so the
    // user can view and update it on an existing invoice.
    if (editInvoice.exchangeRate && Number(editInvoice.exchangeRate) > 0)
      setExchangeRate(Number(editInvoice.exchangeRate));
    setDiscount(editInvoice.discount ?? "");
    setTax(editInvoice.tax ?? "");

    // Rehydrate the header-level reference/payment method stored in the note.
    const parsedHeader = parseInvoiceNotes(editInvoice.notes);
    if (editInvoice.reference || parsedHeader.reference)
      setReference(editInvoice.reference || parsedHeader.reference);
    if (parsedHeader.paymentMethod) setPaymentMethod(parsedHeader.paymentMethod);

    const mapped: EntryLine[] = editInvoice.lines.map((l) => {
      const fab = fabricById(l.fabricId);
      const col = colorById(l.colorId);
      const roll = rollById(l.rollId);
      const line: EntryLine = {
        ...emptyLine(),
        rollId: l.rollId,
        existingFabricId: fab?.id,
        existingColorId: col?.id,
        fabricName: fab?.name ?? "",
        category: fab?.category ?? "",
        unit: (fab?.unit ?? "kg") as EntryLine["unit"],
        colorName: col?.name ?? "",
        colorCode: col?.code ?? "",
        colorHex: col?.hex ?? undefined,
        quantity: l.quantityKg,
        pieces: l.pieces ?? 1,
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
          else if (d.label.includes("كراماج")) line.kromaj = v;
          else if (d.label.includes("GSM")) line.gsm = v;
          else if (d.label.includes("السحب")) line.sahb = v;
          else if (d.label.includes("قائم")) line.grossKg = Number(v) || 0;
        }
      }
      line.notes = roll?.rollNo ? `رقم الصبغة: ${roll.rollNo}` : undefined;
      return line;
    });
    setLines(mapped.length > 0 ? mapped : [emptyLine()]);
  }, [edit, editInvoice]);

  // Repair pass for the async-cache race: if the one-shot prefill above ran
  // while the inventory cache was still empty (fabricById/colorById returned
  // null → empty names), re-resolve ONLY the still-empty identity fields now
  // that the cache has arrived (inventoryVersion changed). Lines are paired
  // by rollId — stable per saved line, so user-added/removed rows can never
  // be mismatched — and anything the operator already typed or picked is
  // left untouched (an empty name/id pair is the only thing repaired).
  useEffect(() => {
    if (!edit || !inventoryVersion) return;
    const rawLines = editRawLinesRef.current;
    if (!rawLines) return;
    setLines((prev) => {
      let changed = false;
      const next = prev.map((l) => {
        const raw = l.rollId ? rawLines.find((r) => r.rollId === l.rollId) : undefined;
        if (!raw) return l;
        let line = l;
        const fab = fabricById(raw.fabricId);
        if (fab && !l.existingFabricId && !l.fabricName.trim()) {
          line = {
            ...line,
            existingFabricId: fab.id,
            fabricName: fab.name,
            category: fab.category ?? "",
            unit: (fab.unit ?? "kg") as EntryLine["unit"],
          };
        }
        const col = colorById(raw.colorId);
        if (col && !l.existingColorId && !l.colorName.trim()) {
          line = {
            ...line,
            existingColorId: col.id,
            colorName: col.name,
            colorCode: col.code,
            colorHex: col.hex ?? undefined,
            colorImageUrl: col.imageUrl ?? undefined,
          };
        }
        const roll = rollById(raw.rollId);
        if (roll?.rollNo && !l.notes) {
          line = { ...line, notes: `رقم الصبغة: ${roll.rollNo}` };
        }
        if (line !== l) changed = true;
        return line;
      });
      return changed ? next : prev;
    });
  }, [edit, inventoryVersion]);

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
    c: {
      id: string;
      fabricId: string;
      name: string;
      code: string;
      hex?: string | null;
      imageUrl?: string | null;
    },
  ) => {
    const line = lines.find((l) => l.id === id);
    const r = resolveColorPick(c, line?.existingFabricId, colors);
    updateLine(id, {
      existingColorId: r.existingColorId,
      colorName: r.colorName,
      colorCode: r.colorCode,
      colorHex: r.hex,
      colorImageUrl: r.imageUrl,
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

  /** Add a new row with the SAME fabric but EMPTY color — used for multi-color per fabric invoices. */
  const addColorForSameFabric = (lineId: string) => {
    const currentLine = lines.find((l) => l.id === lineId);
    if (!currentLine) return;
    const newLine: EntryLine = {
      ...emptyLine(),
      // Preserve fabric identity (all fields from currentLine that relate to fabric)
      existingFabricId: currentLine.existingFabricId,
      fabricName: currentLine.fabricName,
      category: currentLine.category,
      unit: currentLine.unit,
      // Preserve pricing (operator can change per color if needed)
      pricePerKg: currentLine.pricePerKg,
      discountAmount: currentLine.discountAmount,
      // Preserve optional production metadata (operator can change per color if needed)
      marjaiya: currentLine.marjaiya,
      masader: currentLine.masader,
      machineNumber: currentLine.machineNumber,
      kromaj: currentLine.kromaj,
      gsm: currentLine.gsm,
      sahb: currentLine.sahb,
      // Color fields are intentionally left EMPTY so user picks a new color
      // (existingColorId, colorName, colorCode, colorHex, colorImageUrl all undefined/empty from emptyLine())
    };
    const idx = lines.findIndex((l) => l.id === lineId);
    setLines((p) => {
      const next = [...p];
      next.splice(idx + 1, 0, newLine);
      return next;
    });
    setTimeout(() => fabricRefs.current[newLine.id]?.focus(), 0);
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
      const label = l.fabricName.trim() || `سطر #${rows.indexOf(l) + 1}`;
      let bad = false;
      if (!l.fabricName.trim()) {
        flagInvalid(l.id, "fabricName");
        bad = true;
      }
      if (!l.colorName.trim()) {
        flagInvalid(l.id, "colorName");
        bad = true;
      }
      // Color hex must be a valid short hex (# + 3/6/8 digits). Otherwise the
      // backend rejects the whole save with a vague "hex ... غير صالح" — stop
      // here with a clear Arabic message instead of sending a bad request.
      const hexVal = (l.colorHex ?? "").trim();
      if (hexVal && !/^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(hexVal)) {
        flagInvalid(l.id, "colorName");
        setError(
          `حقل "قيمة اللون (hex)" غير صالح: "${hexVal}". استخدم # متبوعاً بثلاثة أو ستة أو ثمانية أرقام (مثل #000000) أو اتركه فارغاً.`,
        );
        showError(`حقل "قيمة اللون" في صبغة "${label}" غير صحيح — استخدم #000000 أو اتركه فارغاً`);
        return;
      }
      if (l.quantity <= 0) {
        flagInvalid(l.id, "quantity");
        bad = true;
      }
      // DB precision guard: rolls.initial_kg / price_per_kg are decimal(12,2)
      // (max 9,999,999,999.99) and roll schema caps initialKg at 100,000 kg.
      // Reject oversized / over-precise values up-front so the backend never
      // fails with a confusing message after the roll was already created —
      // and so the user sees EXACTLY which field is wrong before sending.
      if (l.quantity > 100000) {
        flagInvalid(l.id, "quantity");
        setError(`وزن الصبغة كبير جداً — الحد الأقصى 100,000 كغ.`);
        showError(`الوزن في "${label}" كبير جداً — الحد الأقصى 100,000 كغ`);
        return;
      }
      if (l.quantity > 0 && hasMoreThan2dp(l.quantity)) {
        flagInvalid(l.id, "quantity");
        setError(`الوزن (${l.quantity} كغ) ${MAX_2DP_MSG}.`);
        showError(`الوزن في صبغة "${label}": ${MAX_2DP_MSG}`);
        return;
      }
      if (l.pricePerKg > 9_999_999_999) {
        flagInvalid(l.id, "pricePerKg");
        setError(`سعر الكيلو كبير جداً — الحد الأقصى 9,999,999,999.`);
        showError(`السعر في صبغة "${label}" كبير جداً — الحد الأقصى 9,999,999,999`);
        return;
      }
      if (l.pricePerKg > 0 && hasMoreThan2dp(l.pricePerKg)) {
        flagInvalid(l.id, "pricePerKg");
        setError(`السعر / كغ (${l.pricePerKg}) ${MAX_2DP_MSG}.`);
        showError(`السعر / كغ في صبغة "${label}": ${MAX_2DP_MSG}`);
        return;
      }
      if (l.salePricePerKg != null && l.salePricePerKg > 9_999_999_999) {
        flagInvalid(l.id, "pricePerKg");
        setError(`سعر البيع كبير جداً — الحد الأقصى 9,999,999,999.`);
        showError(`سعر البيع في صبغة "${label}" كبير جداً — الحد الأقصى 9,999,999,999`);
        return;
      }
      if (l.salePricePerKg != null && l.salePricePerKg > 0 && hasMoreThan2dp(l.salePricePerKg)) {
        flagInvalid(l.id, "pricePerKg");
        setError(`سعر البيع / كغ (${l.salePricePerKg}) ${MAX_2DP_MSG}.`);
        showError(`سعر البيع في صبغة "${label}": ${MAX_2DP_MSG}`);
        return;
      }
      if (l.pricePerKg <= 0) {
        flagInvalid(l.id, "pricePerKg");
        bad = true;
      }
      if (bad) {
        setError(`حقول ناقصة على قماش "${label}".`);
        showError(`حقول ناقصة على قماش "${label}" — اسم/لون/وزن/سعر`);
        return;
      }
    }

    // ── Persist side-effects: new fabrics, colors, rolls ───────────
    let newFabrics = 0;
    let newColors = 0;
    let renamedColors = 0;
    const createdRollIds: string[] = [];
    const createdRollNos: string[] = [];
    let totalKg = 0;

    const invLines = [];
    const isEdit = !!edit;
    try {
      // Refresh masters before resolve so typed names re-bind to live IDs
      // instead of silently creating near-duplicate fabrics/colors.
      await refreshInventory();

      for (const l of rows) {
        const typedFabricName = l.fabricName.trim();
        let fabricId = l.existingFabricId;
        let colorId = l.existingColorId;

        const nameMatch = typedFabricName ? fabricByName(typedFabricName) : undefined;
        if (fabricId) {
          const bound = fabricById(fabricId);
          const boundMatchesName =
            !!bound &&
            normalizeInventoryName(bound.name ?? "") === normalizeInventoryName(typedFabricName);
          if (!boundMatchesName) {
            // Stale id or typed name diverged — prefer the live name match.
            fabricId = nameMatch?.id;
          }
        } else if (nameMatch) {
          fabricId = nameMatch.id;
        }

        if (!fabricId) {
          const fab = await addFabric(
            {
              name: typedFabricName,
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
        // ── Color resolution: bound lot vs new lot (edit mode) ──
        // A bound (saved) lot keeps its colorId forever, BUT its name/code/hex
        // may be freely corrected — that RENAMES the color entity in stock.
        // The only rejected action: pointing the lot to a DIFFERENT saved
        // color (picked from the dropdown), which no save can express.
        const rawSaved = isEdit
          ? editRawLinesRef.current?.find((r) => r.rollId === l.rollId)
          : undefined;
        // Rename only for edit-bound lots or an explicit UI pick — never after
        // a code/name lookup reused another line's colour master.
        let mayRenameColor = false;
        if (rawSaved) {
          const boundId = rawSaved.colorId;
          const col0Name = colorById(boundId)?.name ?? "";
          const codeKey = l.colorCode.trim();
          const nameKey = l.colorName.trim();
          const byCode = codeKey ? colorByCode(codeKey, fabricId) : undefined;
          const byName = nameKey
            ? colorsOfFabric(fabricId).find(
                (c) => normalizeInventoryName(c.name) === normalizeInventoryName(nameKey),
              )
            : undefined;
          if ((byCode && byCode.id !== boundId) || (byName && byName.id !== boundId)) {
            const other = byCode && byCode.id !== boundId ? byCode : byName;
            const msg = `البند رقم ${rows.indexOf(l) + 1}: لا يمكن تحويل اللفافة إلى الصبغة «${other?.name}» المحفوظة. احذف هذا البند وأضف صبغة جديدة باللون المطلوب — أو صحّح كتابة اسم/كود نفس اللون (${col0Name}) لإعادة تسميته.`;
            setError(msg);
            showError(msg);
            return;
          }
          colorId = boundId;
          mayRenameColor = true;
        } else {
          if (colorId) {
            const bound = colorById(colorId);
            if (!bound || bound.fabricId !== fabricId) colorId = undefined;
          }
          const explicitlyBoundId = colorId;
          if (!colorId) {
            const codeKey = l.colorCode.trim();
            const nameKey = l.colorName.trim();
            // Fix C-11: fabricId is resolved above (existing or just
            // created) before we ever look up a color code — pass it so the
            // lookup can never merge into a same-code color under a
            // different fabric.
            const existingColor = codeKey ? colorByCode(codeKey, fabricId) : undefined;
            if (existingColor) {
              const sameName =
                !nameKey ||
                normalizeInventoryName(existingColor.name) === normalizeInventoryName(nameKey);
              if (sameName) {
                colorId = existingColor.id;
              }
              // else: leftover code from a sticky/previous line with a NEW
              // typed name → create a distinct colour below (do not rename).
            }
            if (!colorId) {
              const byName = nameKey
                ? colorsOfFabric(fabricId).find(
                    (c) => normalizeInventoryName(c.name) === normalizeInventoryName(nameKey),
                  )
                : undefined;
              if (byName) {
                colorId = byName.id;
              } else {
                const byCodeConflict = codeKey ? colorByCode(codeKey, fabricId) : undefined;
                const codeTaken =
                  !!byCodeConflict &&
                  normalizeInventoryName(byCodeConflict.name) !== normalizeInventoryName(nameKey);
                const col = await addColor(
                  {
                    fabricId,
                    name: nameKey,
                    code:
                      codeKey && !codeTaken
                        ? codeKey
                        : `C-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`,
                    hex: l.colorHex ?? undefined,
                    imageUrl: l.colorImageUrl ?? undefined,
                  },
                  { silent: true },
                );
                colorId = col.id;
                newColors += 1;
              }
            }
          }
          mayRenameColor = !!explicitlyBoundId && explicitlyBoundId === colorId;
        }
        // ── Rename sync: typed name/code/hex ≠ stored → rename the color ──
        if (colorId && mayRenameColor) {
          const col = colorById(colorId);
          if (col) {
            const newName = l.colorName.trim();
            const newCode = l.colorCode.trim();
            const newHex = (l.colorHex ?? "").trim();
            const renamed =
              (newName && newName !== col.name) ||
              (newCode && newCode !== col.code) ||
              (newHex && newHex !== (col.hex ?? ""));
            if (renamed) {
              const conflict = colorsOfFabric(fabricId).find(
                (c) =>
                  c.id !== colorId &&
                  normalizeInventoryName(c.name) === normalizeInventoryName(newName),
              );
              if (conflict) {
                const msg = `الاسم «${newName}» مستخدم أصلاً لصبغة أخرى من نفس القماش — اختر اسماً مختلفاً لإعادة التسمية.`;
                setError(msg);
                showError(msg);
                return;
              }
              await updateColor(
                colorId,
                {
                  name: newName || col.name,
                  code: newCode || col.code || undefined,
                  hex: newHex || col.hex || undefined,
                },
                { silent: true },
              );
              renamedColors += 1;
            }
          }
        }
        const rowNotes = [
          l.marjaiya ? `مرجعية: ${l.marjaiya}` : "",
          l.masader ? `مصدر: ${l.masader}` : "",
          l.machineNumber ? `رقم الماكينة: ${l.machineNumber}` : "",
          l.kromaj ? `كراماج: ${l.kromaj}` : "",
          l.gsm ? `GSM: ${l.gsm}` : "",
          l.sahb ? `السحب: ${l.sahb}` : "",
          l.grossKg ? `وزن قائم: ${l.grossKg}` : "",
          l.notes || "",
        ]
          .filter(Boolean)
          .join(" • ");

        let rollId = l.rollId;
        if (!rollId) {
          // New line on create OR edit: create an empty roll, then the invoice
          // (create/update) stocks it. Backend edit path already accepts rolls
          // introduced by the PUT as long as remainingKg=0 and status=in_stock.
          if (!colorId) {
            throw new Error(
              `يجب تحديد لون للسطر "${l.fabricName || `سطر #${rows.indexOf(l) + 1}`}" قبل الحفظ.`,
            );
          }
          const roll = await addRoll(
            {
              colorId,
              rollNo: `R-${Date.now().toString().slice(-5)}-${l.id.slice(-2)}`,
              dyeBatch: l.dyeBatch,
              initialKg: l.quantity,
              pieces: l.pieces || 1,
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
          rollId = roll.id;
          createdRollIds.push(roll.id);
          createdRollNos.push(roll.rollNo);
        }
        totalKg += l.quantity;
        invLines.push({
          id: `il-${rollId}`,
          fabricId,
          colorId,
          rollId,
          quantityKg: l.quantity,
          pieces: l.pieces || 1,
          pricePerKg: l.pricePerKg,
          discountAmount: l.discountAmount ?? 0,
          note: rowNotes || undefined,
        });
      }
    } catch (e) {
      // Backend 422 responses now carry `details` (field → Arabic reason).
      // Prefer those so the user knows precisely which field is wrong
      // instead of a generic "البيانات المدخلة غير صحيحة".
      const details = (e as { details?: Record<string, string[]> })?.details;
      const detailMsg = detailsText(details);
      const errMsg = detailMsg
        ? `تعذّر حفظ الفاتورة: ${detailMsg}`
        : e instanceof Error
          ? e.message
          : "خطأ في عناصر المخزون";
      setError(errMsg);
      showError(errMsg);
      return;
    }

    const advParts = [
      reference && `المرجع: ${reference}`,
      paymentMethod && `طريقة الدفع: ${paymentMethod}`,
    ].filter(Boolean);

    // FX rule: a non-USD invoice must carry a positive frozen exchange rate.
    // The backend fails closed on this too — this early guard gives instant,
    // field-level feedback instead of a round-trip error.
    if (!isUSD && !(Number(exchangeRate) > 0)) {
      const msg = "سعر الصرف مطلوب لكل عملية ليست بالدولار (عملة الأساس USD)";
      setError(msg);
      showError(msg);
      return;
    }
    const sypError = saneSypRateError(currency, enteredRateNum);
    if (sypError) {
      setError(sypError);
      showError(sypError);
      return;
    }
    if (softWarning && !softWarningAcked) {
      const msg = "أكّد أن سعر الصرف مقصود (مربّع التأكيد بجانب الحقل) قبل الحفظ.";
      setError(msg);
      showError(msg);
      return;
    }

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

    if (isEdit) {
      const res = await update.mutateAsync({
        id: edit as string,
        patch: {
          date,
          discount: Number(discount) || 0,
          tax: Number(tax) || 0,
          shipping: Number(shipping) || 0,
          notes: advParts.join(" • "),
          lines: invLines,
          // Forward manual FX whenever entered — including USD (market reference
          // rate). Base totals stay USD-native; the stored rate is still useful
          // for print/reporting and for later SYP conversions.
          ...(Number(exchangeRate) > 0 ? { exchangeRate: Number(exchangeRate) } : {}),
        },
      });
      if (!res.ok) {
        const rawErr = (res as any).error ?? {};
        const details = rawErr.details as Record<string, string[]> | undefined;
        const firstDetail = details ? details[Object.keys(details)[0]]?.[0] : undefined;
        const msg = firstDetail
          ? `${rawErr.message ?? "فشل تحديث الفاتورة"} — ${firstDetail}`
          : (rawErr.message ?? rawErr.toString?.() ?? "فشل تحديث الفاتورة");
        setError(msg);
        showError(msg);
        return;
      }
      const renameNote =
        renamedColors > 0
          ? " — وأُعيدت تسمية " + (renamedColors === 1 ? "لون واحد" : renamedColors + " ألوان")
          : "";
      const addedNote =
        createdRollIds.length > 0 ? ` — وأُضيفت ${createdRollIds.length} صبغة جديدة للمخزون` : "";
      showSuccess(`تم حفظ تعديلات فاتورة الدخول ${res.value.number}${renameNote}${addedNote}`);
      printOrArchive(
        <InvoicePrintDocument invoice={res.value} />,
        archiveMeta("entry", {
          date: res.value.date,
          typeLabel: "ENTRY",
          number: res.value.number,
        }),
        thenPrint,
      );
      if (thenNew) {
        navigate({ to: "/invoices/entry/new" });
        return;
      }
      navigate({ to: "/invoices/$id", params: { id: res.value.id } });
      return;
    }

    const res = await create.mutateAsync({
      tenantId: buildTenantContext().tenantId,
      // FIN-02: server allocates the authoritative number.
      number: "",
      type: "entry",
      date,
      partyId: supplierId,
      partyType: "supplier",
      currency,
      // Structured reference — no longer only free text inside `notes`.
      reference: reference.trim() || undefined,
      discount: Number(discount) || 0,
      tax: Number(tax) || 0,
      shipping: Number(shipping) || 0,
      lines: invLines,
      notes: advParts.join(" • "),
      paid: paidAmount > 0 ? paidAmount : undefined,
      paymentMethod: paidAmount > 0 ? mapPaymentMethod(paymentMethod) : undefined,
      // FX frozen at creation. Always forward when the user typed a rate —
      // including USD invoices (reference market rate; base_* stay USD amounts).
      ...(Number(exchangeRate) > 0 ? { exchangeRate: Number(exchangeRate) } : {}),
    } as unknown as Parameters<typeof create.mutateAsync>[0]);

    if (!res.ok) {
      const err = (res as any).error;
      const details =
        typeof err === "object"
          ? (err as { details?: Record<string, string[]> })?.details
          : undefined;
      const detailMsg = detailsText(details);
      const msg = detailMsg
        ? detailMsg
        : typeof err === "string"
          ? err
          : (err?.message ?? "فشل إنشاء الفاتورة");
      setError(msg);
      showError(msg);
      return;
    }
    const inv = res.value;

    // ── Success — toast + inventory impact summary ────────────────
    const impactParts: string[] = [];
    impactParts.push(
      `أُضيف ${createdRollIds.length} صبغة (${formatNumber(totalKg)} كغ) إلى المخزون`,
    );
    if (newFabrics > 0) impactParts.push(`+${newFabrics} قماش جديد`);
    if (newColors > 0) impactParts.push(`+${newColors} لون جديد`);
    showSuccess(`تم حفظ فاتورة الدخول رقم ${inv.number} — ${impactParts.join(" • ")}`);

    printOrArchive(
      <InvoicePrintDocument invoice={inv} />,
      archiveMeta("entry", { date: inv.date, typeLabel: "ENTRY", number: inv.number }),
      thenPrint,
    );
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
      <div className="mx-auto w-full max-w-[1400px] space-y-4 pb-24">
        <InvoiceHeader
          variant="entry"
          invoiceNumber={invoiceNo}
          date={date}
          status={dataLines.length === 0 ? "مسودة" : "جاهزة للحفظ"}
          actions={<ExitWithoutSavingButton />}
        />

        {/* Header row — 5 fields, supplier now inline-searchable + inline-create */}
        <section className="overflow-hidden rounded-lg border border-border bg-card">
          <div className="flex items-center gap-2 border-b border-border/60 bg-secondary/20 px-4 py-2">
            <div className="h-[3px] w-5 bg-primary/25 rounded-sm" />
            <span className="text-[11px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
              بيانات الفاتورة
            </span>
          </div>
          <div className="grid gap-x-4 gap-y-3 p-4 md:grid-cols-[minmax(0,2fr)_minmax(0,1.2fr)_minmax(0,1fr)_minmax(0,1fr)_minmax(0,1fr)]">
            <HeaderField label="المورد *">
              <SupplierInlineCombobox value={supplierId} onChange={setSupplierId} />
            </HeaderField>
            <HeaderField label="رقم الفاتورة">
              <Input
                className={cn("h-9 tabular-nums", !reference && "text-muted-foreground/70")}
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
            <HeaderField label="سعر الصرف (ل.س / $)">
              <FormattedAmountInput
                value={exchangeRate}
                onChange={setExchangeRate}
                placeholder={isUSD ? "اختياري للدولار (سعر مرجعي)" : "أدخل سعر الصرف يدوياً"}
                ariaLabel="سعر الصرف"
                className="!h-9 text-left tabular-nums"
              />
              {softWarning && (
                <div
                  role="alert"
                  data-testid="entry-invoice-syp-rate-soft-warning"
                  className="mt-1 rounded-md border border-warning/40 bg-warning/10 px-2 py-1.5 text-[11px] leading-snug text-foreground"
                >
                  <p>{softWarning}</p>
                  <label className="mt-1 flex items-center gap-1.5 font-semibold">
                    <input
                      type="checkbox"
                      checked={softWarningAcked}
                      onChange={(e) => setSoftWarningAcked(e.target.checked)}
                    />
                    السعر صحيح ومقصود، تابع الحفظ
                  </label>
                </div>
              )}
            </HeaderField>
            <HeaderField label="الدفع">
              <PaymentMethodSelect
                value={paymentMethod}
                onChange={setPaymentMethod}
                methods={enabledPaymentMethods}
              />
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
                      ? "border-dashed border-border/60 bg-secondary/[0.02]"
                      : "border-border hover:border-primary/30",
                  )}
                >
                  {/* Card header */}
                  <div className="flex items-center justify-between gap-2 border-b border-border/60 px-3 py-1.5">
                    <div className="flex items-center gap-2">
                      <span
                        className={cn(
                          "grid h-6 min-w-[28px] place-items-center rounded-md px-2 text-[11px] font-medium tabular-nums",
                          rowIsEmpty
                            ? "bg-secondary/60 text-muted-foreground"
                            : "bg-secondary text-foreground",
                        )}
                      >
                        {i + 1}
                      </span>
                      <span className="text-xs font-medium text-muted-foreground">
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
                          {formatMoney(lineSubtotal(l))}
                          <span className="mr-1 text-[10px] font-medium text-muted-foreground/60">
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
                      {!rowIsEmpty && l.fabricName && (
                        <button
                          type="button"
                          onClick={() => addColorForSameFabric(l.id)}
                          className="grid h-7 w-7 place-items-center rounded-md text-muted-foreground transition hover:bg-primary/10 hover:text-primary"
                          aria-label="إضافة لون لنفس القماش"
                          title={`إضافة لون جديد لـ ${l.fabricName}`}
                        >
                          <Palette className="h-3.5 w-3.5" />
                        </button>
                      )}
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
                  <div className="space-y-3 p-4">
                    {/* ── بيانات القماش ── */}
                    <GroupSection title="بيانات القماش">
                      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-[minmax(0,2fr)_minmax(0,1fr)_minmax(0,1fr)]">
                        <CardField label="نوع القماش" required>
                          <InlineFabricCell
                            ref={(el) => {
                              fabricRefs.current[l.id] = el;
                            }}
                            value={l.fabricName}
                            existingFabricId={l.existingFabricId}
                            className={fieldHasError(l.id, "fabricName") ? invalidCls : undefined}
                            onPickExisting={(fid) => pickExistingFabric(l.id, fid)}
                            onSetName={(name) => {
                              const match = fabricByName(name);
                              if (match) {
                                // Re-bind to the existing master while typing the same name
                                // (including after a prior keystroke cleared existingFabricId).
                                updateLine(l.id, {
                                  fabricName: name,
                                  existingFabricId: match.id,
                                  category: match.category ?? l.category,
                                  unit: match.unit ?? l.unit,
                                });
                              } else {
                                updateLine(l.id, {
                                  fabricName: name,
                                  existingFabricId: undefined,
                                });
                              }
                            }}
                          />
                        </CardField>
                        <CardField label="المرجعية">
                          <Input
                            value={l.marjaiya}
                            onChange={(e) => updateLine(l.id, { marjaiya: e.target.value })}
                            className={cn("h-9", !l.marjaiya && "text-muted-foreground/70")}
                            placeholder="—"
                            aria-label="المرجعية"
                          />
                        </CardField>
                        <CardField label="المصدر">
                          <Input
                            value={l.masader}
                            onChange={(e) => updateLine(l.id, { masader: e.target.value })}
                            className={cn("h-9", !l.masader && "text-muted-foreground/70")}
                            placeholder="—"
                            aria-label="المصدر"
                          />
                        </CardField>
                      </div>
                    </GroupSection>

                    {/* ── بيانات الإنتاج ── */}
                    <GroupSection title="بيانات الإنتاج">
                      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                        <CardField label="الأثواب">
                          <FormattedAmountInput
                            value={l.pieces || ""}
                            onChange={(v) =>
                              updateLine(l.id, {
                                pieces: v === "" ? 1 : Math.max(1, Math.trunc(v)),
                              })
                            }
                            className={cn(
                              "h-9 text-left tabular-nums",
                              !l.pieces && "text-muted-foreground/70",
                            )}
                            placeholder="1"
                            ariaLabel="عدد الأثواب"
                          />
                          <p className="mt-0.5 text-[10px] leading-tight text-muted-foreground">
                            يُضاف للمخزون ويُخصم عند البيع ويظهر في الطباعة.
                          </p>
                        </CardField>
                        <CardField label="رقم الماكينة">
                          <Input
                            value={l.machineNumber}
                            onChange={(e) => updateLine(l.id, { machineNumber: e.target.value })}
                            className={cn("h-9", !l.machineNumber && "text-muted-foreground/70")}
                            placeholder="—"
                            aria-label="رقم الماكينة"
                          />
                        </CardField>
                        <CardField label="كراماج">
                          <Input
                            value={l.kromaj}
                            onChange={(e) => updateLine(l.id, { kromaj: e.target.value })}
                            className={cn("h-9", !l.kromaj && "text-muted-foreground/70")}
                            placeholder="—"
                            aria-label="كراماج"
                          />
                        </CardField>
                        <CardField label="السحب">
                          <Input
                            value={l.sahb}
                            onChange={(e) => updateLine(l.id, { sahb: e.target.value })}
                            className={cn(
                              "h-9 tabular-nums",
                              !l.sahb && "text-muted-foreground/70",
                            )}
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
                        renameMode={!!edit && !!l.rollId}
                      />
                      {!!edit && !!l.existingColorId && (
                        <p className="mt-1 text-[10px] leading-tight text-muted-foreground">
                          ✏️ تعديل الاسم/الكود يعيد تسمية لون هذه الصبغة في المخزون — وتحويل اللفافة
                          نفسها إلى صبغة أخرى محفوظة غير مسموح.
                        </p>
                      )}
                    </GroupSection>

                    {/* ── بيانات الوزن ── */}
                    <GroupSection title="بيانات الوزن">
                      <div className="grid grid-cols-2 gap-3">
                        <CardField label="الوزن القائم (كغ)">
                          <FormattedAmountInput
                            value={l.grossKg || ""}
                            onChange={(v) => updateLine(l.id, { grossKg: v === "" ? 0 : v })}
                            className={cn(
                              "h-9 text-left tabular-nums",
                              !l.grossKg && "text-muted-foreground/70",
                            )}
                            placeholder="0"
                            ariaLabel="الوزن القائم"
                          />
                        </CardField>
                        <CardField label="الوزن الصافي (كغ)" required>
                          <FormattedAmountInput
                            value={l.quantity || ""}
                            onChange={(v) => updateLine(l.id, { quantity: v === "" ? 0 : v })}
                            className={cn(
                              "h-9 text-left tabular-nums",
                              !l.quantity && "text-muted-foreground/70",
                            )}
                            placeholder="0"
                            ariaLabel="الوزن الصافي"
                          />
                        </CardField>
                      </div>
                    </GroupSection>

                    {/* ── بيانات الصباغة ── */}
                    <GroupSection title="بيانات الصباغة">
                      <div className="max-w-[16rem]">
                        <CardField label="رقم الصبغة">
                          <Input
                            value={l.dyeBatch}
                            onChange={(e) => updateLine(l.id, { dyeBatch: e.target.value })}
                            className={cn(
                              "h-9 tabular-nums",
                              !l.dyeBatch && "text-muted-foreground/70",
                            )}
                            placeholder="DY-…"
                            aria-label="رقم الصبغة"
                          />
                        </CardField>
                      </div>
                    </GroupSection>

                    {/* ── بيانات الشراء ── */}
                    <GroupSection title="بيانات الشراء">
                      <div className="grid grid-cols-2 gap-3 md:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_minmax(0,1.2fr)]">
                        <CardField label={`السعر / كغ (${currencySymbol(currency)})`} required>
                          <FormattedAmountInput
                            value={l.pricePerKg}
                            onChange={(v) => updateLine(l.id, { pricePerKg: v === "" ? 0 : v })}
                            className={cn(
                              "h-9 text-left tabular-nums",
                              !l.pricePerKg && "text-muted-foreground/70",
                              isUSD && l.pricePerKg > 0 && "text-success font-semibold",
                            )}
                            placeholder="0"
                            ariaLabel="سعر الوحدة"
                          />
                        </CardField>
                        <CardField label="الخصم">
                          <FormattedAmountInput
                            value={l.discountAmount}
                            onChange={(v) =>
                              // Fixed amount, decimals kept — same as the sale form.
                              updateLine(l.id, { discountAmount: v === "" ? 0 : Math.max(0, v) })
                            }
                            onKeyDown={(e) => handleRowEnd(e, l.id)}
                            className={cn(
                              "h-9 text-left tabular-nums",
                              !l.discountAmount && "text-muted-foreground/70",
                            )}
                            placeholder="0"
                            ariaLabel="الخصم"
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
                              {formatMoney(lineSubtotal(l))}
                              <span className="mr-1 text-[10px] font-medium text-muted-foreground/60">
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
                {dataLines.length} صبغة • {formatNumber(totalQty)} كغ
              </span>
              <span
                className={cn(
                  "text-sm font-bold tabular-nums",
                  isUSD ? "text-success" : "text-foreground",
                )}
              >
                {formatMoney(subtotal)}
                <span className="mr-1 text-[10px] font-medium text-muted-foreground/60">
                  {currencySymbol(currency)}
                </span>
              </span>
            </div>
          )}
        </section>

        {/* ── Totals ─────────────────────────────────────────────── */}
        <section className={cn("overflow-hidden rounded-lg border border-border bg-card")}>
          <div className="flex items-center gap-2 border-b border-border/60 bg-secondary/20 px-4 py-2">
            <div className="h-[3px] w-5 bg-primary/25 rounded-sm" />
            <span className="text-[11px] font-bold uppercase tracking-[0.16em] text-muted-foreground">
              المجاميع
            </span>
          </div>
          <div className="grid gap-x-6 gap-y-2 px-4 py-3 sm:grid-cols-2">
            <TotalCell label="الكمية" value={`${formatNumber(totalQty)} كغ`} />
            <TotalCell label="المجموع" value={`${formatMoney(subtotal)}`} tone={moneyClass} />
          </div>
          <div className="grid gap-x-6 gap-y-3 border-t border-border/60 px-4 py-3 sm:grid-cols-2 lg:grid-cols-4">
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
          </div>
          <div
            className={cn(
              "flex flex-wrap items-center justify-between gap-3 border-t border-border/60 bg-secondary/20 px-4 py-3",
            )}
          >
            <span
              className={cn(
                "text-[11px] font-bold uppercase tracking-[0.16em] text-muted-foreground",
              )}
            >
              الإجمالي الكلي
            </span>
            <span
              className={cn(
                "text-2xl font-black leading-tight tabular-nums",
                isUSD ? "text-success" : "text-primary",
              )}
            >
              {formatMoney(grandTotal)}
              <span className="mr-1 text-sm font-medium text-muted-foreground/60">
                {currencySymbol(currency)}
              </span>
            </span>
          </div>
          <div className="flex items-center justify-end gap-2 border-t px-3 py-2 text-xs font-semibold">
            <span className="text-muted-foreground">المتبقي:</span>
            <span className={cn("tabular-nums font-bold", moneyClass)}>
              {/* Always computed from the FULL stored grand total — never from a
                  rounded/abbreviated display value (audit rule 3). Shown even
                  when paid = 0 so screen and print always agree. */}
              {formatMoney(Math.max(0, grandTotal - (paid === "" ? 0 : Number(paid))))}
              <span className="mr-1 text-[10px] font-medium text-muted-foreground/60">
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
        // I12: disable all save buttons while a mutation is in flight —
        // double-clicking used to post duplicate invoices.
        isSaving={create.isPending || update.isPending}
        onSave={() => save(false)}
        onSaveAndPrint={() => save(true)}
        onSaveAndNew={() => save(false, true)}
        onCancel={() => history.back()}
        saveLabel="حفظ الفاتورة"
        extra={
          <span className="hidden text-xs text-muted-foreground tabular-nums sm:inline">
            {dataLines.length} بند • الإجمالي:{" "}
            <span className={cn("font-semibold", moneyClass)}>
              {formatMoney(grandTotal)} {currencySymbol(currency)}
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
