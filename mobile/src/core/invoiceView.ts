// Everything the invoice detail screen and the PDF need, read through the phone's repositories.
import type { InvoiceData } from "@backend/domain/entities/Invoice";
import type { ArchiveInvoiceLine } from "@erp/shared";
import type { InvoicePrintData } from "../print/renderHtml";
import type { Phone } from "./phone";

export interface InvoiceLineView {
  id: string;
  fabric: string;
  color: string;
  rollNo: string;
  quantityKg: number;
  pieces: number;
  pricePerKg: number;
  discountAmount: number;
  lineTotal: number;
}

export interface InvoiceView {
  invoice: InvoiceData;
  partyName: string;
  lines: InvoiceLineView[];
}

export async function loadInvoiceView(phone: Phone, id: string): Promise<InvoiceView | null> {
  const ctx = phone.context();
  const invoice = await phone.repos.invoiceRepo.findById(id, ctx);
  if (!invoice) return null;
  const party = await phone.repos.partyRepo.findById(invoice.partyId, ctx);
  // `searchRepo.rollsByIds` deliberately fails on the desktop twin (owner decision O-1): one lookup per roll instead.
  const rollNo = new Map<string, string>();
  for (const l of invoice.lines) {
    if (rollNo.has(l.rollId)) continue;
    const roll = await phone.repos.rollRepo.findById(l.rollId, ctx);
    if (roll) rollNo.set(l.rollId, roll.rollNo);
  }
  const lines: InvoiceLineView[] = [];
  for (const l of invoice.lines) {
    const fabric = await phone.repos.fabricRepo.findById(l.fabricId, ctx);
    const color = await phone.repos.colorRepo.findById(l.colorId, ctx);
    lines.push({
      id: l.id,
      fabric: fabric?.name ?? "",
      color: color?.name ?? "",
      rollNo: rollNo.get(l.rollId) ?? "",
      quantityKg: l.quantityKg,
      pieces: l.pieces,
      pricePerKg: l.pricePerKg,
      discountAmount: l.discountAmount,
      lineTotal: Math.max(
        0,
        Math.round((l.quantityKg * l.pricePerKg - l.discountAmount) * 100) / 100,
      ),
    });
  }
  return { invoice, partyName: party?.name ?? "", lines };
}

/** The shared archive builders' input (the same HTML the desktop archives), so the PDF equals what the desktop prints. */
export function toPrintData(view: InvoiceView): InvoicePrintData {
  const i = view.invoice;
  return {
    header: {
      kind: i.type === "sale" ? "sale" : "entry",
      number: i.number,
      date: i.date,
      partyName: view.partyName,
      currency: i.currency,
      subtotal: i.subtotal,
      discount: i.discount,
      tax: i.tax,
      shipping: i.shipping,
      total: i.total,
      paid: i.paid,
      cancelled: i.status === "cancelled",
      notes: i.notes ?? null,
    },
    lines: view.lines.map((l): ArchiveInvoiceLine => ({
      fabric: l.fabric,
      color: l.color,
      rollNo: l.rollNo,
      pieces: l.pieces,
      quantityKg: l.quantityKg,
      pricePerKg: l.pricePerKg,
      discountAmount: l.discountAmount,
      lineTotal: l.lineTotal,
    })),
  };
}
