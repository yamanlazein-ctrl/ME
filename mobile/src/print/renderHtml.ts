// Phone print layouts (FR-29, research R8, spike S3).
//
// Deviation from R8, recorded in evidence/T036.md: the desktop print components
// (src/components/print/InvoicePrintDocument.tsx, PartyStatementDocument.tsx) cannot be bundled by Metro:
// they pull in the web data layer (useSettings/useLedger → React Query + the API client), a CSS import and
// a Vite-only `?inline` image. The desktop already ships the same documents as pure HTML builders in
// packages/shared/src/archiveDocuments.ts (used by the Drive archive "so an archived document matches what the
// user prints"). The phone uses those builders unchanged, so the amounts come from the same code.
import {
  buildInvoiceBody,
  buildStatementBody,
  escapeHtml,
  fmtMoney,
  fmtKg,
  wrapArchiveDocument,
  type ArchiveInvoiceHeader,
  type ArchiveInvoiceLine,
  type ArchiveLeg,
  type ArchivePaper,
} from "@erp/shared";

export interface InvoicePrintData {
  header: ArchiveInvoiceHeader;
  lines: ArchiveInvoiceLine[];
  paper?: ArchivePaper;
}

export interface StatementPrintData {
  partyName: string;
  partyKind: "customer" | "supplier";
  currency: string;
  periodFrom: string;
  periodTo: string;
  opening: number;
  legs: ArchiveLeg[];
  paper?: ArchivePaper;
}

export function renderInvoiceHtml(data: InvoicePrintData): string {
  return wrapArchiveDocument({
    title: data.header.number,
    bodyHtml: buildInvoiceBody(data.header, data.lines),
    paper: data.paper ?? "A4",
  });
}

export function renderStatementHtml(data: StatementPrintData): string {
  return wrapArchiveDocument({
    title: `${data.partyName} — ${data.currency}`,
    bodyHtml: buildStatementBody(data),
    paper: data.paper ?? "A4",
  });
}

export interface VoucherPrintData {
  kind: "receipt" | "payment";
  number: string;
  date: string;
  partyName: string;
  amount: number;
  discount: number;
  currency: string;
  method: string;
  cancelled: boolean;
  paper?: ArchivePaper;
}

const METHOD_LABEL: Record<string, string> = {
  cash: "نقداً",
  transfer: "حوالة",
  check: "شيك",
  card: "بطاقة",
};

/** A receipt / payment voucher page (the desktop has no pure-HTML builder for vouchers; same wrapper and number format). */
export function renderVoucherHtml(data: VoucherPrintData): string {
  const title = data.kind === "receipt" ? "سند قبض" : "سند دفع";
  const net = Number(data.amount) - Number(data.discount || 0);
  const body = `
<h1>${escapeHtml(title)} ${escapeHtml(data.number)}${data.cancelled ? " — ملغى" : ""}</h1>
<table class="arc-meta">
  <tr><td>التاريخ</td><td>${escapeHtml(data.date)}</td></tr>
  <tr><td>${data.kind === "receipt" ? "استلمنا من" : "دفعنا إلى"}</td><td>${escapeHtml(data.partyName)}</td></tr>
  <tr><td>طريقة الدفع</td><td>${escapeHtml(METHOD_LABEL[data.method] ?? data.method)}</td></tr>
  <tr><td>المبلغ</td><td class="arc-num">${fmtMoney(data.amount)} ${escapeHtml(data.currency)}</td></tr>
  ${data.discount ? `<tr><td>الحسم</td><td class="arc-num">${fmtMoney(data.discount)} ${escapeHtml(data.currency)}</td></tr>` : ""}
  <tr><td>الصافي</td><td class="arc-num">${fmtMoney(net)} ${escapeHtml(data.currency)}</td></tr>
</table>`;
  return wrapArchiveDocument({
    title: `${title} ${data.number}`,
    bodyHtml: body,
    paper: data.paper ?? "A4",
  });
}

export interface ReturnPrintData {
  kind: "sale" | "entry";
  number: string;
  date: string;
  partyName: string;
  currency: string;
  cancelled: boolean;
  lines: Array<{ label: string; quantityKg: number; pricePerKg: number }>;
  paper?: ArchivePaper;
}

export function renderReturnHtml(data: ReturnPrintData): string {
  const title = data.kind === "sale" ? "مرتجع بيع" : "مرتجع شراء";
  const total = data.lines.reduce((s, l) => s + l.quantityKg * l.pricePerKg, 0);
  const rows = data.lines
    .map(
      (l) =>
        `<tr><td>${escapeHtml(l.label)}</td><td class="arc-num">${fmtKg(l.quantityKg)}</td><td class="arc-num">${fmtMoney(l.pricePerKg)}</td><td class="arc-num">${fmtMoney(l.quantityKg * l.pricePerKg)}</td></tr>`,
    )
    .join("\n");
  const body = `
<h1>${escapeHtml(title)} ${escapeHtml(data.number)}${data.cancelled ? " — ملغى" : ""}</h1>
<p>${escapeHtml(data.partyName)} — ${escapeHtml(data.date)}</p>
<table><thead><tr><th>البند</th><th>الكمية (كغ)</th><th>السعر</th><th>المجموع</th></tr></thead><tbody>${rows}</tbody></table>
<p class="arc-num">الإجمالي: ${fmtMoney(total)} ${escapeHtml(data.currency)}</p>`;
  return wrapArchiveDocument({
    title: `${title} ${data.number}`,
    bodyHtml: body,
    paper: data.paper ?? "A4",
  });
}
