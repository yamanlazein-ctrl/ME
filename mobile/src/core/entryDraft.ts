// The purchase (entry) draft, memory only like the sale draft. Totals come from the shared `invoiceTotal`.
import {
  computeSubtotal,
  invoiceTotal,
  round2dp,
  saneSypRateError,
  type InvoiceLineData,
} from "@erp/shared";
import type { EntryInvoiceInput, EntryLineInput } from "./documents";
import type { PaymentMethod } from "./lineNote";

export interface EntryDraftLine extends EntryLineInput {
  key: string;
}

export interface EntryDraft {
  supplier: { id: string; name: string } | null;
  currency: string;
  exchangeRate: number | null;
  lines: EntryDraftLine[];
  discount: number;
  tax: number;
  shipping: number;
  paid: number;
  /** The supplier's invoice number (رقم الفاتورة), optional. */
  reference: string;
  /** YYYY-MM-DD; empty means today. */
  date: string;
  paymentMethod: PaymentMethod;
  notes: string;
}

export function emptyEntryDraft(): EntryDraft {
  return {
    reference: "",
    date: "",
    paymentMethod: "cash",
    notes: "",
    supplier: null,
    currency: "USD",
    exchangeRate: null,
    lines: [],
    discount: 0,
    tax: 0,
    shipping: 0,
    paid: 0,
  };
}

const asLines = (lines: EntryDraftLine[]): InvoiceLineData[] =>
  lines.map((l) => ({
    id: l.key,
    fabricId: l.fabricId ?? "",
    colorId: l.colorId ?? "",
    rollId: "",
    quantityKg: l.quantityKg,
    pieces: l.pieces,
    pricePerKg: l.pricePerKg,
    discountAmount: l.discountAmount ?? 0,
  })) as InvoiceLineData[];

/** A line's value: net kg × price − its discount (the desktop's line total). */
export function entryLineTotal(
  l: Pick<EntryLineInput, "quantityKg" | "pricePerKg" | "discountAmount">,
) {
  return Math.max(0, round2dp(l.quantityKg * l.pricePerKg - (l.discountAmount ?? 0)));
}

export function entryTotals(draft: EntryDraft): {
  subtotal: number;
  total: number;
  due: number;
  kg: number;
  pieces: number;
} {
  const lines = asLines(draft.lines);
  const total = invoiceTotal({
    lines,
    discount: draft.discount,
    tax: draft.tax,
    shipping: draft.shipping,
  });
  return {
    subtotal: computeSubtotal(lines),
    total,
    due: round2dp(total - Math.min(draft.paid, total)),
    kg: round2dp(draft.lines.reduce((s, l) => s + l.quantityKg, 0)),
    pieces: draft.lines.reduce((s, l) => s + (l.pieces || 0), 0),
  };
}

export type EntryProblem =
  "no-supplier" | "no-rate" | "bad-rate" | "no-lines" | "bad-line" | "bad-date" | "paid-over-total";

export const ENTRY_PROBLEM_TEXT: Record<EntryProblem, string> = {
  "no-supplier": "اختر المورد",
  "no-rate": "اكتب سعر الصرف: الفاتورة ليست بالدولار",
  "bad-rate": "سعر الصرف غير منطقي لليرة السورية (أقل من 1,000) — تأكد من الأصفار",
  "no-lines": "أضف بنداً واحداً على الأقل",
  "bad-line": "في أحد البنود الكمية أو السعر أو الاسم غير صحيح",
  "bad-date": "اكتب التاريخ بالشكل 2026-03-31",
  "paid-over-total": "المدفوع أكبر من إجمالي الفاتورة",
};

/** Problems of one line before it is added (the desktop's line rules). */
export type LineProblem =
  "no-fabric" | "no-color" | "no-kg" | "no-price" | "discount-over" | "gross-under";

export const LINE_PROBLEM_TEXT: Record<LineProblem, string> = {
  "no-fabric": "اكتب نوع القماش",
  "no-color": "اكتب اسم اللون",
  "no-kg": "اكتب الوزن الصافي (أكبر من صفر)",
  "no-price": "اكتب سعر الكيلو",
  "discount-over": "الخصم أكبر من قيمة البند",
  "gross-under": "الوزن القائم أقل من الوزن الصافي",
};

export function lineProblems(l: EntryLineInput): LineProblem[] {
  const out: LineProblem[] = [];
  if (!l.fabricName.trim()) out.push("no-fabric");
  if (!l.colorName.trim()) out.push("no-color");
  if (!(l.quantityKg > 0)) out.push("no-kg");
  if (!(l.pricePerKg > 0)) out.push("no-price");
  if ((l.discountAmount ?? 0) > l.quantityKg * l.pricePerKg + 1e-9) out.push("discount-over");
  const gross = l.details?.grossKg ?? null;
  if (gross !== null && gross > 0 && gross + 1e-9 < l.quantityKg) out.push("gross-under");
  return out;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function entryProblems(draft: EntryDraft): EntryProblem[] {
  const out: EntryProblem[] = [];
  if (!draft.supplier) out.push("no-supplier");
  if (draft.currency !== "USD" && !(draft.exchangeRate && draft.exchangeRate > 0))
    out.push("no-rate");
  if (saneSypRateError(draft.currency, draft.exchangeRate)) out.push("bad-rate");
  if (draft.lines.length === 0) out.push("no-lines");
  if (draft.lines.some((l) => lineProblems(l).length > 0)) out.push("bad-line");
  if (draft.date && !DATE_RE.test(draft.date)) out.push("bad-date");
  if (draft.lines.length > 0 && draft.paid > entryTotals(draft).total + 1e-9) {
    out.push("paid-over-total");
  }
  return out;
}

export function toEntryInput(draft: EntryDraft, today: string): EntryInvoiceInput {
  if (!draft.supplier) throw new Error("incomplete entry draft");
  return {
    date: draft.date || today,
    ...(draft.reference.trim() ? { reference: draft.reference.trim() } : {}),
    paymentMethod: draft.paymentMethod,
    ...(draft.notes.trim() ? { notes: draft.notes.trim() } : {}),
    supplierId: draft.supplier.id,
    currency: draft.currency,
    // A USD purchase is at rate 1 (the base currency); other currencies carry the typed rate.
    exchangeRate: draft.currency === "USD" ? 1 : (draft.exchangeRate ?? 0),
    lines: draft.lines.map(({ key, ...line }) => {
      void key;
      return line;
    }),
    discount: draft.discount,
    tax: draft.tax,
    shipping: draft.shipping,
    paid: draft.paid,
  };
}

/**
 * A new line of the same fabric and colour (the next roll of a delivery): keeps the names, price, production details
 * and the lot's specs; the weights, pieces, dye number and discount are the new roll's own.
 */
export function copyOfLine(l: EntryLineInput): Partial<EntryLineInput> {
  const { grossKg: _gross, ...details } = l.details ?? {};
  void _gross;
  return {
    ...(l.fabricId ? { fabricId: l.fabricId } : {}),
    fabricName: l.fabricName,
    ...(l.colorId ? { colorId: l.colorId } : {}),
    colorName: l.colorName,
    ...(l.colorCode ? { colorCode: l.colorCode } : {}),
    pricePerKg: l.pricePerKg,
    details,
    ...(l.widthCm ? { widthCm: l.widthCm } : {}),
    ...(l.weightGsm ? { weightGsm: l.weightGsm } : {}),
    ...(l.salePricePerKg ? { salePricePerKg: l.salePricePerKg } : {}),
  };
}
