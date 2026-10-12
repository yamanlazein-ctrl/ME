/**
 * Per-type print visibility — controls which real fields are shown
 * in the printed document. The field is *never* removed from the
 * underlying model — this is a print-time toggle only.
 *
 * Defaults: ALL FIELDS VISIBLE. The user can hide specific fields
 * via /settings/invoice if they want, but nothing is hidden by
 * default — every real field on the invoice must be in the print
 * unless the user explicitly opts out.
 */
import { settings, useSettings, updatePrintVisibility } from "@/presentation/hooks/useSettings";

export type InvoiceKind = "purchase" | "sale" | "return_in" | "return_out";

export type FieldKey =
  // Header / meta
  | "showInvoiceNumber"
  | "showDate"
  | "showStatus"
  | "showCurrency"
  | "showCreatedBy"
  | "showCreatedAt"
  | "showCancelledInfo"
  | "showTypeBadge"
  // Party block
  | "showPartyName"
  | "showPartyPhone"
  | "showPartyAddress"
  | "showPartyCode"
  // Items table
  | "showLineIndex"
  | "showFabric"
  | "showFabricCategory"
  | "showColorCode"
  | "showColorName"
  | "showRollNumber"
  | "showQuantity"
  | "showUnitPrice"
  | "showLineDiscount"
  | "showLineTotal"
  | "showLineNote"
  // Totals
  | "showSubtotal"
  | "showDiscountTotal"
  | "showTax"
  | "showGrandTotal"
  // Payment
  | "showPaymentSummary"
  | "showPaymentMethod"
  // Notes & meta
  | "showNotes"
  | "showSignatures"
  | "showOriginalInvoice"
  | "showReason"
  | "showFooter";

const STORAGE_KEY = "motard.invoice.printVisibility.v2";

/** Every field defaults to ON. The user only hides what they don't want. */
const ALL_FIELDS: FieldKey[] = [
  "showInvoiceNumber",
  "showDate",
  "showStatus",
  "showCurrency",
  "showCreatedBy",
  "showCreatedAt",
  "showCancelledInfo",
  "showTypeBadge",
  "showPartyName",
  "showPartyPhone",
  "showPartyAddress",
  "showPartyCode",
  "showLineIndex",
  "showFabric",
  "showFabricCategory",
  "showColorCode",
  "showColorName",
  "showRollNumber",
  "showQuantity",
  "showUnitPrice",
  "showLineDiscount",
  "showLineTotal",
  "showLineNote",
  "showSubtotal",
  "showDiscountTotal",
  "showTax",
  "showGrandTotal",
  "showPaymentSummary",
  "showPaymentMethod",
  "showNotes",
  "showSignatures",
  "showOriginalInvoice",
  "showReason",
  "showFooter",
];

export const DEFAULT_VISIBILITY: Record<InvoiceKind, Record<FieldKey, boolean>> = {
  purchase: Object.fromEntries(
    ALL_FIELDS.map((f) => {
      if (f === "showCreatedBy" || f === "showPaymentMethod") return [f, false];
      return [f, true];
    }),
  ) as Record<FieldKey, boolean>,
  sale: Object.fromEntries(
    ALL_FIELDS.map((f) => {
      if (f === "showCreatedBy" || f === "showPaymentMethod") return [f, false];
      return [f, true];
    }),
  ) as Record<FieldKey, boolean>,
  return_in: Object.fromEntries(ALL_FIELDS.map((f) => [f, true])) as Record<FieldKey, boolean>,
  return_out: Object.fromEntries(ALL_FIELDS.map((f) => [f, true])) as Record<FieldKey, boolean>,
};

export const FIELD_LABELS: Record<FieldKey, string> = {
  showInvoiceNumber: "رقم المستند",
  showDate: "التاريخ",
  showStatus: "الحالة",
  showCurrency: "العملة",
  showCreatedBy: "أنشأ بواسطة",
  showCreatedAt: "تاريخ الإنشاء",
  showCancelledInfo: "تاريخ الإلغاء",
  showTypeBadge: "شارة النوع",
  showPartyName: "اسم الطرف",
  showPartyPhone: "هاتف الطرف",
  showPartyAddress: "عنوان الطرف",
  showPartyCode: "رمز الطرف",
  showLineIndex: "ترتيب السطر (#)",
  showFabric: "القماش",
  showFabricCategory: "فئة القماش",
  showColorCode: "رقم اللون",
  showColorName: "اسم اللون",
  showRollNumber: "رقم الصبغة",
  showQuantity: "الكمية (كغ)",
  showUnitPrice: "سعر الكيلو",
  showLineDiscount: "خصم السطر %",
  showLineTotal: "إجمالي السطر",
  showLineNote: "ملاحظة السطر",
  showSubtotal: "المجموع الفرعي",
  showDiscountTotal: "إجمالي الخصم",
  showTax: "الضريبة",
  showGrandTotal: "الإجمالي النهائي",
  showPaymentSummary: "ملخص الدفع (مدفوع/متبقي)",
  showPaymentMethod: "طريقة الدفع",
  showNotes: "الملاحظات",
  showSignatures: "التوقيعات",
  showOriginalInvoice: "الفاتورة الأصلية (للمرتجعات)",
  showReason: "سبب الإرجاع",
  showFooter: "تذييل المستند",
};

type Stored = Partial<Record<InvoiceKind, Partial<Record<FieldKey, boolean>>>>;

/** The pre-F-017 device-local copy: still honoured until this device's next save moves it to the server. */
function legacyLocal(): Stored | undefined {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Stored) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * hermes F-017: the source of truth is `settings.printing.invoiceVisibility`, which is saved with
 * PUT /api/settings/printing and replicates to every device (it used to be one browser's
 * localStorage, so another workstation printed every field). Defaults merge in, so new fields are ON.
 */
function loadVisibility(): Record<InvoiceKind, Record<FieldKey, boolean>> {
  const stored = (settings.printing.invoiceVisibility as Stored | undefined) ?? legacyLocal();
  const out = {} as Record<InvoiceKind, Record<FieldKey, boolean>>;
  for (const kind of Object.keys(DEFAULT_VISIBILITY) as InvoiceKind[]) {
    out[kind] = { ...DEFAULT_VISIBILITY[kind], ...(stored?.[kind] ?? {}) };
  }
  return out;
}

function saveVisibility(v: Record<InvoiceKind, Record<FieldKey, boolean>>) {
  updatePrintVisibility(v);
}

/** Hook: returns the current visibility map for a given kind (re-renders when settings change). */
export function useInvoiceVisibility(kind: InvoiceKind): Record<FieldKey, boolean> {
  useSettings();
  return loadVisibility()[kind];
}

/** Imperative API for the settings page to toggle fields and persist. */
export function setFieldVisibility(
  kind: InvoiceKind,
  field: FieldKey,
  visible: boolean,
): Record<InvoiceKind, Record<FieldKey, boolean>> {
  const cur = loadVisibility();
  cur[kind] = { ...cur[kind], [field]: visible };
  saveVisibility(cur);
  return cur;
}

export function resetKindVisibility(kind: InvoiceKind) {
  const cur = loadVisibility();
  cur[kind] = { ...DEFAULT_VISIBILITY[kind] };
  saveVisibility(cur);
  return cur;
}

export function getAllVisibility(): Record<InvoiceKind, Record<FieldKey, boolean>> {
  return loadVisibility();
}

export const INVOICE_KIND_LABELS: Record<InvoiceKind, { label: string; short: string }> = {
  purchase: { label: "فاتورة شراء (دخول)", short: "PURCHASE" },
  sale: { label: "فاتورة بيع", short: "SALE" },
  return_in: { label: "مرتجع شراء (للمورّد)", short: "RETURN IN" },
  return_out: { label: "مرتجع بيع (من العميل)", short: "RETURN OUT" },
};

export const INVOICE_KIND_ORDER: InvoiceKind[] = ["purchase", "sale", "return_in", "return_out"];

export { STORAGE_KEY as VISIBILITY_STORAGE_KEY };
