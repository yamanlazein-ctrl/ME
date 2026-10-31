// The purchase line's production details, written into the invoice line note exactly as the desktop's purchase form
// writes them (src/routes/invoices.entry.new.tsx), so the desktop's invoice page, print and edit form read a phone-made
// line like one of its own. Reading uses the desktop's own parser.
import {
  parseInvoiceNotes,
  parseLineNote,
  type ParsedLineNote,
} from "@web/components/print/noteParser";

export { parseInvoiceNotes, parseLineNote, type ParsedLineNote };

export interface EntryLineDetails {
  /** المرجعية */
  reference?: string;
  /** المصدر */
  source?: string;
  /** رقم الماكينة */
  machineNo?: string;
  /** كراماج */
  kromaj?: string;
  /** السحب */
  draw?: string;
  /** الوزن القائم (كغ) — for information; the stock and the price use the net weight. */
  grossKg?: number | null;
  /** Free text after the structured fields. */
  note?: string;
}

const clean = (v: string | undefined): string => (v ?? "").trim().replace(/\s*•\s*/g, " ");

/** The line note in the desktop's order and words; undefined when there is nothing to write. */
export function buildEntryLineNote(d: EntryLineDetails): string | undefined {
  const parts = [
    clean(d.reference) && `مرجعية: ${clean(d.reference)}`,
    clean(d.source) && `مصدر: ${clean(d.source)}`,
    clean(d.machineNo) && `رقم الماكينة: ${clean(d.machineNo)}`,
    clean(d.kromaj) && `كراماج: ${clean(d.kromaj)}`,
    clean(d.draw) && `السحب: ${clean(d.draw)}`,
    d.grossKg && d.grossKg > 0 ? `وزن قائم: ${d.grossKg}` : "",
    clean(d.note),
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" • ") : undefined;
}

export type PaymentMethod = "cash" | "transfer" | "check" | "card";

export const PAYMENT_METHOD_LABEL: Record<PaymentMethod, string> = {
  cash: "نقدي",
  transfer: "تحويل بنكي",
  check: "شيك",
  card: "بطاقة",
};

/** The invoice notes the desktop writes: «المرجع: X • طريقة الدفع: Y», then any free text. */
export function buildInvoiceNotes(d: {
  reference?: string;
  paymentMethod?: PaymentMethod;
  notes?: string;
}): string | undefined {
  const parts = [
    clean(d.reference) && `المرجع: ${clean(d.reference)}`,
    d.paymentMethod ? `طريقة الدفع: ${PAYMENT_METHOD_LABEL[d.paymentMethod]}` : "",
    clean(d.notes),
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(" • ") : undefined;
}
