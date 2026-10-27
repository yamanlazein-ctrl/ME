// The purchase (entry) draft, memory only like the sale draft. Totals come from the shared `invoiceTotal`.
import { computeSubtotal, invoiceTotal, round2dp, type InvoiceLineData } from "@erp/shared";
import type { EntryInvoiceInput, EntryLineInput } from "./documents";

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
}

export function emptyEntryDraft(): EntryDraft {
  return {
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
    discountAmount: 0,
  })) as InvoiceLineData[];

export function entryTotals(draft: EntryDraft): { subtotal: number; total: number; due: number } {
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
  };
}

export type EntryProblem = "no-supplier" | "no-rate" | "no-lines" | "bad-line";

export const ENTRY_PROBLEM_TEXT: Record<EntryProblem, string> = {
  "no-supplier": "اختر المورد",
  "no-rate": "اكتب سعر الصرف",
  "no-lines": "أضف بنداً واحداً على الأقل",
  "bad-line": "في أحد البنود الكمية أو السعر أو الاسم غير صحيح",
};

export function entryProblems(draft: EntryDraft): EntryProblem[] {
  const out: EntryProblem[] = [];
  if (!draft.supplier) out.push("no-supplier");
  if (!draft.exchangeRate || draft.exchangeRate <= 0) out.push("no-rate");
  if (draft.lines.length === 0) out.push("no-lines");
  if (
    draft.lines.some(
      (l) =>
        !(l.quantityKg > 0) || !(l.pricePerKg >= 0) || !l.fabricName.trim() || !l.colorName.trim(),
    )
  ) {
    out.push("bad-line");
  }
  return out;
}

export function toEntryInput(draft: EntryDraft, date: string): EntryInvoiceInput {
  if (!draft.supplier || !draft.exchangeRate) throw new Error("incomplete entry draft");
  return {
    date,
    supplierId: draft.supplier.id,
    currency: draft.currency,
    exchangeRate: draft.exchangeRate,
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
