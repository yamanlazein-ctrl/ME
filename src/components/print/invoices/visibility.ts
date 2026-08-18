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
import { useEffect, useState } from "react";

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

const DEFAULT_VISIBILITY: Record<InvoiceKind, Record<FieldKey, boolean>> = {
  purchase: Object.fromEntries(ALL_FIELDS.map((f) => [f, true])) as Record<FieldKey, boolean>,
  sale: Object.fromEntries(ALL_FIELDS.map((f) => [f, true])) as Record<FieldKey, boolean>,
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

function loadVisibility(): Record<InvoiceKind, Record<FieldKey, boolean>> {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_VISIBILITY;
    const parsed = JSON.parse(raw) as Record<InvoiceKind, Record<FieldKey, boolean>>;
    // Merge defaults so newly added fields default to ON
    for (const kind of Object.keys(DEFAULT_VISIBILITY) as InvoiceKind[]) {
      parsed[kind] = { ...DEFAULT_VISIBILITY[kind], ...(parsed[kind] ?? {}) };
    }
    return parsed;
  } catch {
    return DEFAULT_VISIBILITY;
  }
}

function saveVisibility(v: Record<InvoiceKind, Record<FieldKey, boolean>>) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(v));
  } catch {
    /* ignore quota */
  }
}

/** Hook: returns the current visibility map for a given kind. */
export function useInvoiceVisibility(kind: InvoiceKind): Record<FieldKey, boolean> {
  const [vis, setVis] = useState<Record<FieldKey, boolean>>(() => loadVisibility()[kind]);
  useEffect(() => {
    const onStorage = () => setVis(loadVisibility()[kind]);
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, [kind]);
  return vis;
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
  // Notify other tabs / listeners in the same page
  window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));
  return cur;
}

export function resetKindVisibility(kind: InvoiceKind) {
  const cur = loadVisibility();
  cur[kind] = { ...DEFAULT_VISIBILITY[kind] };
  saveVisibility(cur);
  window.dispatchEvent(new StorageEvent("storage", { key: STORAGE_KEY }));
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
