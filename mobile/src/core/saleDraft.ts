// The sale draft (memory only) and its numbers. Totals are never computed here: they come from the shared `invoiceTotal`,
// the same function the invoice domain entity uses, so the screen can never differ from what the use-case saves.
import {
  computeSubtotal,
  invoiceTotal,
  round2dp,
  saneSypRateError,
  type InvoiceLineData,
} from "@erp/shared";
import type { CreateInvoiceInput } from "@backend/domain/entities/Invoice";

export interface DraftLine {
  key: string;
  fabricId: string;
  fabricName: string;
  colorId: string;
  colorName: string;
  rollId: string;
  rollNo: string;
  /** The lot's own currency: a line in another currency than the invoice needs a rate (the desktop's rule). */
  rollCurrency: string;
  /** Kg left on the roll when the line was added (a sale may not take more). */
  remainingKg: number;
  quantityKg: number;
  /** Zero is allowed (FR-15). */
  pieces: number;
  pricePerKg: number;
  /** A fixed amount off this line. */
  discountAmount: number;
}

export interface SaleDraft {
  party: { id: string; name: string } | null;
  currency: string;
  exchangeRate: number | null;
  lines: DraftLine[];
  /** Fixed amounts, not percentages. */
  discount: number;
  tax: number;
  shipping: number;
  paid: number;
}

export function emptyDraft(): SaleDraft {
  return {
    party: null,
    currency: "USD",
    exchangeRate: null,
    lines: [],
    discount: 0,
    tax: 0,
    shipping: 0,
    paid: 0,
  };
}

function asLines(lines: DraftLine[]): InvoiceLineData[] {
  return lines.map((l) => ({
    id: l.key,
    fabricId: l.fabricId,
    colorId: l.colorId,
    rollId: l.rollId,
    quantityKg: l.quantityKg,
    pieces: l.pieces,
    pricePerKg: l.pricePerKg,
    discountAmount: l.discountAmount,
  }));
}

export function draftTotals(draft: SaleDraft): { subtotal: number; total: number; due: number } {
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

export type DraftProblem =
  "no-party" | "no-rate" | "bad-rate" | "no-lines" | "bad-quantity" | "over-stock" | "bad-price";

export const DRAFT_PROBLEM_TEXT: Record<DraftProblem, string> = {
  "no-party": "اختر العميل",
  "no-rate": "اكتب سعر الصرف: الفاتورة ليست بالدولار أو إحدى الصبغات بعملة أخرى",
  "bad-rate": "سعر الصرف غير منطقي لليرة السورية (أقل من 1,000) — تأكد من الأصفار",
  "no-lines": "أضف بنداً واحداً على الأقل",
  "bad-quantity": "الكمية يجب أن تكون أكبر من صفر",
  "over-stock": "الكمية أكبر من المتبقي في الصبغة",
  "bad-price": "السعر غير صحيح",
};

/** The desktop's rule: a rate is required when the invoice is not in USD or a lot is priced in another currency. */
export function needsRate(draft: Pick<SaleDraft, "currency" | "lines">): boolean {
  return draft.currency !== "USD" || draft.lines.some((l) => l.rollCurrency !== draft.currency);
}

export function draftProblems(draft: SaleDraft): DraftProblem[] {
  const out: DraftProblem[] = [];
  if (!draft.party) out.push("no-party");
  if (needsRate(draft) && !(draft.exchangeRate && draft.exchangeRate > 0)) out.push("no-rate");
  if (saneSypRateError(draft.currency, draft.exchangeRate)) out.push("bad-rate");
  if (draft.lines.length === 0) out.push("no-lines");
  if (draft.lines.some((l) => !(l.quantityKg > 0))) out.push("bad-quantity");
  if (draft.lines.some((l) => l.quantityKg > l.remainingKg)) out.push("over-stock");
  if (draft.lines.some((l) => !(l.pricePerKg >= 0))) out.push("bad-price");
  return out;
}

/** The input of the invoice use-case. Throws when the draft is incomplete (callers check `draftProblems` first). */
export function toCreateInput(draft: SaleDraft, date: string): CreateInvoiceInput {
  if (!draft.party) throw new Error("incomplete sale draft");
  return {
    type: "sale",
    date,
    partyId: draft.party.id,
    partyType: "customer",
    currency: draft.currency,
    ...(draft.exchangeRate && draft.exchangeRate > 0 ? { exchangeRate: draft.exchangeRate } : {}),
    lines: draft.lines.map((l) => ({
      fabricId: l.fabricId,
      colorId: l.colorId,
      rollId: l.rollId,
      quantityKg: l.quantityKg,
      pieces: l.pieces,
      pricePerKg: l.pricePerKg,
      discountAmount: l.discountAmount,
    })),
    discount: draft.discount,
    tax: draft.tax,
    shipping: draft.shipping,
    paid: draft.paid,
  } as CreateInvoiceInput;
}
