// Document PDFs (FR-29, FR-30): builds the PDF of an invoice, voucher, return or statement with the shared print builders,
// names the file after the document, and opens the share sheet (src/core/share.ts).
import { getApp } from "../core/appRuntime";
import { loadInvoiceView, toPrintData } from "../core/invoiceView";
import { loadFullStatement } from "../core/partyQueries";
import type { Phone } from "../core/phone";
import { sharePdf, type ShareOutcome } from "../core/share";
import { deviceShareDeps } from "../platform/shareDeps";
import {
  renderInvoiceHtml,
  renderReturnHtml,
  renderStatementHtml,
  renderVoucherHtml,
} from "./renderHtml";
import { htmlToPdf, pdfFileName } from "./toPdf";

export type DocRef =
  | { type: "invoice"; id: string }
  | { type: "voucher"; id: string }
  | { type: "return"; id: string }
  | { type: "statement"; partyId: string; kind: "customer" | "supplier" };

export interface PreparedPdf {
  partyName: string;
  /** "فاتورة INV-000012" — the share sheet's title. */
  title: string;
  pdfUri: string;
}

async function phoneOrThrow(): Promise<Phone> {
  const app = await getApp();
  if (!app.phone) throw new Error("الجهاز غير مسجّل");
  return app.phone;
}

/** Renders the document to a named PDF in the app cache. Nothing leaves the phone yet. */
export async function preparePdf(ref: DocRef): Promise<PreparedPdf> {
  const phone = await phoneOrThrow();
  const ctx = phone.context();
  let html: string;
  let partyId: string;
  let note: string;
  let file: string;
  if (ref.type === "invoice") {
    const view = await loadInvoiceView(phone, ref.id);
    if (!view) throw new Error("الفاتورة غير موجودة");
    html = renderInvoiceHtml(toPrintData(view));
    partyId = view.invoice.partyId;
    note = `فاتورة ${view.invoice.number}`;
    file = pdfFileName("Invoice", view.invoice.number);
  } else if (ref.type === "voucher") {
    const v = await phone.repos.voucherRepo.findById(ref.id, ctx);
    if (!v) throw new Error("السند غير موجود");
    const party = await phone.repos.partyRepo.findById(v.partyId, ctx);
    html = renderVoucherHtml({
      kind: v.kind,
      number: v.number,
      date: v.date,
      partyName: party?.name ?? "",
      amount: v.amount,
      discount: v.discount ?? 0,
      currency: v.currency,
      method: v.method ?? "cash",
      cancelled: v.status === "cancelled",
    });
    partyId = v.partyId;
    note = `سند ${v.number}`;
    file = pdfFileName(v.kind === "payment" ? "Payment" : "Receipt", v.number);
  } else if (ref.type === "return") {
    const r = await phone.repos.returnRepo.findById(ref.id, ctx);
    if (!r) throw new Error("المرتجع غير موجود");
    const party = await phone.repos.partyRepo.findById(r.partyId, ctx);
    const lines = [];
    for (const l of r.lines) {
      const roll = await phone.repos.rollRepo.findById(l.rollId, ctx);
      lines.push({
        label: roll?.rollNo ?? "",
        quantityKg: l.quantityKg,
        pricePerKg: l.pricePerKg,
      });
    }
    html = renderReturnHtml({
      kind: r.kind === "entry" ? "entry" : "sale",
      number: r.number,
      date: r.date,
      partyName: party?.name ?? "",
      currency: r.currency,
      cancelled: r.status === "cancelled",
      lines,
    });
    partyId = r.partyId;
    note = `مرتجع ${r.number}`;
    file = pdfFileName("Return", r.number);
  } else {
    const party = await phone.repos.partyRepo.findById(ref.partyId, ctx);
    if (!party) throw new Error("الطرف غير موجود");
    const full = await loadFullStatement(phone, { partyId: ref.partyId, kind: ref.kind });
    const rows = full.entries.filter((e) => e.status === "active");
    html = renderStatementHtml({
      partyName: party.name,
      partyKind: ref.kind,
      currency: party.currency ?? "USD",
      periodFrom: rows[0]?.date ?? "",
      periodTo: rows[rows.length - 1]?.date ?? "",
      opening: Number((full.header as { openingBalance?: number }).openingBalance ?? 0),
      legs: rows.map((e, i) => ({
        date: e.date,
        createdAt: `${e.date}T00:00:00.${String(i).padStart(6, "0")}Z`,
        docRank: e.type === "receipt_in" || e.type === "payment_out" ? 2 : 1,
        id: e.id,
        type: e.type,
        reference: e.referenceNumber ?? "",
        description: e.description ?? "",
        debit: Number(e.debit),
        credit: Number(e.credit),
        status: e.status,
      })),
    });
    partyId = ref.partyId;
    note = `كشف حساب ${party.name}`;
    file = pdfFileName("Statement", rows[rows.length - 1]?.date ?? "");
  }
  const party = await phone.repos.partyRepo.findById(partyId, ctx);
  return { partyName: party?.name ?? "", title: note, pdfUri: await htmlToPdf(html, file) };
}

/** Builds the PDF and opens the share sheet. */
export async function shareDocument(ref: DocRef): Promise<ShareOutcome> {
  const prepared = await preparePdf(ref);
  return sharePdf(prepared.pdfUri, prepared.title, deviceShareDeps);
}
