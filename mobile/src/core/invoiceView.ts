// Everything the invoice detail screen and the PDF need, read through the phone's repositories.
import type { InvoiceData } from "@backend/domain/entities/Invoice";
import type { ArchiveInvoiceLine } from "@erp/shared";
import type { InvoicePrintData } from "../print/renderHtml";
import type { DesktopInvoicePrint } from "../print/desktopInvoiceHtml";
import type { Phone } from "./phone";

export interface InvoiceLineView {
  id: string;
  rollId: string;
  fabric: string;
  color: string;
  rollNo: string;
  quantityKg: number;
  pieces: number;
  pricePerKg: number;
  discountAmount: number;
  lineTotal: number;
  colorCode: string | null;
  colorHex: string | null;
  dyeBatch: string | null;
  widthCm: number | null;
  weightGsm: number | null;
  /** The line note (production details written the desktop's way). */
  note: string | null;
}

export interface InvoiceParty {
  name: string;
  phone: string | null;
  address: string | null;
  city: string | null;
  code: string | null;
}

export interface LinkedVoucher {
  id: string;
  kind: "receipt" | "payment";
  number: string;
  date: string;
  amount: number;
  currency: string;
  method: string;
}

export interface InvoiceView {
  invoice: InvoiceData;
  partyName: string;
  party: InvoiceParty;
  lines: InvoiceLineView[];
  /** Active receipts / payments tied to this invoice (the desktop page's voucher list). */
  vouchers: LinkedVoucher[];
}

const numOrNull = (v: unknown): number | null =>
  v === null || v === undefined || v === "" || !(Number(v) > 0) ? null : Number(v);

export async function loadInvoiceView(phone: Phone, id: string): Promise<InvoiceView | null> {
  const ctx = phone.context();
  const invoice = await phone.repos.invoiceRepo.findById(id, ctx);
  if (!invoice) return null;
  const party = await phone.repos.partyRepo.findById(invoice.partyId, ctx);
  // `searchRepo.rollsByIds` deliberately fails on the desktop twin (owner decision O-1): one lookup per roll instead.
  const rolls = new Map<string, Awaited<ReturnType<typeof phone.repos.rollRepo.findById>>>();
  for (const l of invoice.lines) {
    if (!rolls.has(l.rollId))
      rolls.set(l.rollId, await phone.repos.rollRepo.findById(l.rollId, ctx));
  }
  const lines: InvoiceLineView[] = [];
  for (const l of invoice.lines) {
    const fabric = await phone.repos.fabricRepo.findById(l.fabricId, ctx);
    const color = await phone.repos.colorRepo.findById(l.colorId, ctx);
    const roll = rolls.get(l.rollId) ?? null;
    lines.push({
      id: l.id,
      rollId: l.rollId,
      fabric: fabric?.name ?? "",
      color: color?.name ?? "",
      rollNo: roll?.rollNo ?? "",
      quantityKg: l.quantityKg,
      pieces: l.pieces,
      pricePerKg: l.pricePerKg,
      discountAmount: l.discountAmount,
      lineTotal: Math.max(
        0,
        Math.round((l.quantityKg * l.pricePerKg - l.discountAmount) * 100) / 100,
      ),
      colorCode: color?.code ?? null,
      colorHex: color?.hex ?? null,
      dyeBatch: roll?.dyeBatch ?? null,
      widthCm: numOrNull(roll?.widthCm),
      weightGsm: numOrNull(roll?.weightGsm),
      note: l.note ?? null,
    });
  }
  const linked = await phone.repos.voucherRepo.list(
    { invoiceId: invoice.id, status: "active", limit: 50 },
    ctx,
  );
  return {
    invoice,
    vouchers: linked.data.map((v) => ({
      id: v.id,
      kind: v.kind,
      number: v.number,
      date: String(v.date).slice(0, 10),
      amount: Number(v.amount),
      currency: v.currency,
      method: v.method ?? "cash",
    })),
    partyName: party?.name ?? "",
    party: {
      name: party?.name ?? "",
      phone: party?.phone ?? null,
      address: party?.address ?? null,
      city: party?.city ?? null,
      code: party?.code ?? null,
    },
    lines,
  };
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

/** The desktop print templates' input (print/desktopInvoiceHtml.ts). */
export function toDesktopPrint(view: InvoiceView): DesktopInvoicePrint {
  const i = view.invoice;
  return {
    type: i.type === "sale" ? "sale" : "entry",
    number: i.number,
    reference: i.reference ?? null,
    date: String(i.date).slice(0, 10),
    currency: i.currency,
    cancelled: i.status === "cancelled",
    cancelledAt: i.cancelledAt ? String(i.cancelledAt) : null,
    exchangeRate: i.exchangeRate ?? null,
    baseTotal: i.baseTotal ?? null,
    paymentMethod: i.paymentMethod ?? null,
    party: view.party,
    lines: view.lines.map((l) => ({
      fabric: l.fabric,
      colorName: l.color,
      colorCode: l.colorCode,
      colorHex: l.colorHex,
      rollNo: l.rollNo,
      dyeBatch: l.dyeBatch,
      pieces: l.pieces,
      quantityKg: l.quantityKg,
      pricePerKg: l.pricePerKg,
      lineTotal: l.lineTotal,
      note: l.note,
      weightGsm: l.weightGsm,
    })),
    subtotal: Number(i.subtotal),
    discount: Number(i.discount),
    tax: Number(i.tax),
    shipping: Number(i.shipping),
    total: Number(i.total),
    paid: Number(i.paid),
    piecesCount: i.piecesCount ?? null,
    notes: i.notes ?? null,
  };
}
