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
import { buildInvoiceNotes, type PaymentMethod } from "./lineNote";

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
  /** Pieces left on the roll (the desktop refuses more). */
  remainingPieces?: number;
  /** «ملاحظة (اختياري)» of the line. */
  note?: string;
  /** The lot's cost per kg: selling below it is warned about (the desktop's warning). */
  costPerKg?: number;
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
  /** «رقم المرجعية», optional. */
  reference: string;
  /** YYYY-MM-DD; empty means today. */
  date: string;
  paymentMethod: PaymentMethod;
  notes: string;
  /** «خصم من رصيد العميل الدائن»: settle with the customer's available credit (the desktop's checkbox). */
  useCredit: boolean;
}

export function emptyDraft(): SaleDraft {
  return {
    reference: "",
    date: "",
    paymentMethod: "cash",
    notes: "",
    useCredit: false,
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

/**
 * How a new sale is settled — the desktop's planSaleSettlement (src/presentation/hooks/useCustomerCredit.ts): cash
 * first (capped at the total; the rest becomes the customer's credit), then credit if chosen, the remainder is debt.
 */
export function saleSettlement(input: {
  total: number;
  cashPaid: number;
  availableCredit: number;
  useCredit: boolean;
}): { cashApplied: number; creditApplied: number; excessCash: number; debt: number } {
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const total = Math.max(0, r2(input.total));
  const cash = Math.max(0, r2(input.cashPaid));
  const cashApplied = Math.min(cash, total);
  const excessCash = r2(cash - cashApplied);
  const creditApplied = input.useCredit
    ? r2(Math.min(Math.max(0, input.availableCredit), total - cashApplied))
    : 0;
  const debt = r2(total - cashApplied - creditApplied);
  return { cashApplied: r2(cashApplied), creditApplied, excessCash, debt: Math.max(0, debt) };
}

export function draftTotals(draft: SaleDraft): {
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

export type DraftProblem =
  | "no-party"
  | "no-rate"
  | "bad-rate"
  | "no-lines"
  | "bad-quantity"
  | "over-stock"
  | "over-pieces"
  | "bad-price"
  | "discount-over"
  | "bad-date";

export const DRAFT_PROBLEM_TEXT: Record<DraftProblem, string> = {
  "no-party": "اختر العميل",
  "no-rate": "اكتب سعر الصرف: الفاتورة ليست بالدولار أو إحدى الصبغات بعملة أخرى",
  "bad-rate": "سعر الصرف غير منطقي لليرة السورية (أقل من 1,000) — تأكد من الأصفار",
  "no-lines": "أضف بنداً واحداً على الأقل",
  "bad-quantity": "الكمية يجب أن تكون أكبر من صفر",
  "over-stock": "الكمية أكبر من المتبقي في الصبغة",
  "bad-price": "السعر غير صحيح",
  "over-pieces": "عدد الأثواب أكبر من المتبقي في الصبغة",
  "discount-over": "خصم أحد البنود أكبر من قيمته",
  "bad-date": "اكتب التاريخ بالشكل 2026-03-31",
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
  if (draft.lines.some((l) => l.remainingPieces !== undefined && l.pieces > l.remainingPieces)) {
    out.push("over-pieces");
  }
  if (draft.lines.some((l) => l.discountAmount > l.quantityKg * l.pricePerKg + 1e-9)) {
    out.push("discount-over");
  }
  if (draft.date && !/^\d{4}-\d{2}-\d{2}$/.test(draft.date)) out.push("bad-date");
  return out;
}

/**
 * The input of the invoice use-case, as the desktop's sale form sends it (reference, payment method, notes «المرجع … •
 * طريقة الدفع … • …», credit applied). Throws when the draft is incomplete (callers check `draftProblems` first).
 */
export function toCreateInput(
  draft: SaleDraft,
  today: string,
  availableCredit = 0,
): CreateInvoiceInput {
  if (!draft.party) throw new Error("incomplete sale draft");
  const { creditApplied } = saleSettlement({
    total: draftTotals(draft).total,
    cashPaid: draft.paid,
    availableCredit,
    useCredit: draft.useCredit,
  });
  const notes = buildInvoiceNotes({
    reference: draft.reference,
    paymentMethod: draft.paymentMethod,
    notes: draft.notes,
  });
  return {
    type: "sale",
    date: draft.date || today,
    ...(draft.reference.trim() ? { reference: draft.reference.trim() } : {}),
    paymentMethod: draft.paymentMethod,
    ...(creditApplied > 0 ? { creditApplied } : {}),
    ...(notes ? { notes } : {}),
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
      ...(l.note?.trim() ? { note: l.note.trim() } : {}),
    })),
    discount: draft.discount,
    tax: draft.tax,
    shipping: draft.shipping,
    paid: draft.paid,
  } as CreateInvoiceInput;
}
