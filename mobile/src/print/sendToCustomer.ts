// "Send to customer" (FR-30, E13): builds the PDF of an invoice, voucher, return or statement, finds the party's phone, and
// hands both to src/core/share.ts. A missing phone is reported to the caller, which asks for one.
import { getApp } from "../core/appRuntime";
import { loadInvoiceView, toPrintData } from "../core/invoiceView";
import { loadFullStatement } from "../core/partyQueries";
import type { Phone } from "../core/phone";
import { sendToCustomer, type SendResult } from "../core/share";
import { deviceShareDeps } from "../platform/shareDeps";
import {
  renderInvoiceHtml,
  renderReturnHtml,
  renderStatementHtml,
  renderVoucherHtml,
} from "./renderHtml";
import { htmlToPdf } from "./toPdf";

export type DocRef =
  | { type: "invoice"; id: string }
  | { type: "voucher"; id: string }
  | { type: "return"; id: string }
  | { type: "statement"; partyId: string; kind: "customer" | "supplier" };

export interface PreparedSend {
  partyId: string;
  partyName: string;
  partyVersion: number;
  phone: string | null;
  note: string;
  pdfUri: string;
}

async function phoneOrThrow(): Promise<Phone> {
  const app = await getApp();
  if (!app.phone) throw new Error("الجهاز غير مسجّل");
  return app.phone;
}

/** Renders the document to a PDF and reads the party's saved phone. Nothing leaves the phone yet. */
export async function prepareSend(ref: DocRef): Promise<PreparedSend> {
  const phone = await phoneOrThrow();
  const ctx = phone.context();
  let html: string;
  let partyId: string;
  let note: string;
  if (ref.type === "invoice") {
    const view = await loadInvoiceView(phone, ref.id);
    if (!view) throw new Error("الفاتورة غير موجودة");
    html = renderInvoiceHtml(toPrintData(view));
    partyId = view.invoice.partyId;
    note = `فاتورة ${view.invoice.number}`;
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
  }
  const party = await phone.repos.partyRepo.findById(partyId, ctx);
  return {
    partyId,
    partyName: party?.name ?? "",
    partyVersion: party?.version ?? 0,
    phone: party?.mobile || party?.whatsapp || party?.phone || null,
    note,
    pdfUri: await htmlToPdf(html),
  };
}

/** Saves a phone number typed by the user on the party (E13); the party's own update use-case and sync unit. */
export async function savePartyPhone(prepared: PreparedSend, phoneNumber: string): Promise<void> {
  const phone = await phoneOrThrow();
  const r = await phone.documents.updateParty(
    prepared.partyId,
    { phone: phoneNumber },
    prepared.partyVersion,
  );
  if (!r.ok) throw new Error(r.error);
}

export function send(prepared: PreparedSend, phoneNumber: string): Promise<SendResult> {
  return sendToCustomer(
    { phone: phoneNumber, note: prepared.note, pdfUri: prepared.pdfUri },
    deviceShareDeps,
  );
}
