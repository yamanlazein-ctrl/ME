// The invoice PDF in the desktop's printed design: the same page shell (src/components/print/PrintDocument.tsx), the same
// purchase / sale templates (src/components/print/invoices/EntryInvoicePrint.tsx, SaleInvoicePrint.tsx), the same
// stylesheet and logo (generated from the desktop's files) and the same number formatting. The desktop renders these
// with React DOM, which the phone cannot bundle; this renders the identical markup as an HTML string for expo-print.
import { escapeHtml } from "@erp/shared";
import { formatMoney, formatNumber, formatQuantity } from "@web/shared/utils/formatNumber";
import { parseLineNote } from "@web/components/print/noteParser";
import { FIXED_PRINT_FOOTER_LINES, PRINT_BRAND_NAME } from "@web/shared/constants/printConfig";
import { DESKTOP_LOGO_DATA_URI, DESKTOP_PRINT_CSS } from "./generated/desktopPrint";

/** The desktop's INVOICE_LINES_PER_PRINT_PAGE. */
export const LINES_PER_PAGE = 10;

const SYMBOL: Record<string, string> = { SYP: "ل.س", USD: "$", EUR: "€" };
const symbol = (c: string) => SYMBOL[c] ?? c;
/** The desktop's formatAmount: the symbol isolated so RTL text cannot flip it past the amount. */
const amount = (n: number, c: string) => `⁦${symbol(c)}⁩ ${formatMoney(n)}`;
/** The desktop's keepTogether: a date stays one LTR unit with non-breaking hyphens. */
const keepTogether = (s: string) => `⁦${s.replace(/-/g, "‑")}⁩`;
const e = escapeHtml;

export const PAYMENT_LABEL: Record<string, string> = {
  cash: "نقدي",
  transfer: "تحويل بنكي",
  check: "شيك",
  card: "بطاقة",
};

export interface DesktopInvoiceLine {
  fabric: string;
  colorName: string;
  colorCode?: string | null;
  colorHex?: string | null;
  rollNo?: string | null;
  dyeBatch?: string | null;
  pieces: number;
  quantityKg: number;
  pricePerKg: number;
  lineTotal: number;
  /** The line note (production details the desktop's way). */
  note?: string | null;
  /** The lot's grammage: the desktop prints it as «الكراماج» when the note has none. */
  weightGsm?: number | null;
}

export interface DesktopInvoicePrint {
  type: "sale" | "entry";
  number: string;
  reference?: string | null;
  date: string;
  currency: string;
  cancelled: boolean;
  cancelledAt?: string | null;
  exchangeRate?: number | null;
  baseTotal?: number | null;
  paymentMethod?: string | null;
  party: {
    name: string;
    phone?: string | null;
    address?: string | null;
    city?: string | null;
    code?: string | null;
  };
  lines: DesktopInvoiceLine[];
  subtotal: number;
  discount: number;
  tax: number;
  shipping: number;
  total: number;
  paid: number;
  piecesCount?: number | null;
  notes?: string | null;
  /** The printing settings' footer note (the desktop's default when empty). */
  footerNote?: string | null;
}

type Meta = { label: string; value: string };

function colorCell(l: DesktopInvoiceLine): string {
  const name = l.colorName.trim();
  if (!name && !l.colorCode) return `<span class="pd-color-missing">—</span>`;
  const swatch = `<span class="pd-color-swatch" style="display:inline-block;background:${
    /^#[0-9a-fA-F]{3,8}$/.test(l.colorHex ?? "") ? l.colorHex : "#d1d5db"
  }"></span>`;
  const code = (l.colorCode ?? "").trim();
  return `<div class="pd-color-cell"><div class="pd-color-top">${swatch}<span class="pd-color-name">${e(
    name || "—",
  )}</span></div>${code ? `<span class="pd-color-code" dir="ltr">${e(code)}</span>` : ""}</div>`;
}

/** The desktop's line detail sub-row: machine, kromaj (or the lot's grammage), draw, reference. */
export function lineDetails(l: DesktopInvoiceLine): Meta[] {
  const parsed = parseLineNote(l.note);
  const out: Meta[] = [];
  if (parsed.machineNo) out.push({ label: "رقم الماكينة", value: parsed.machineNo });
  if (parsed.chromaj) out.push({ label: "الكراماج", value: parsed.chromaj });
  else if (l.weightGsm) out.push({ label: "الكراماج", value: String(l.weightGsm) });
  if (parsed.draw) out.push({ label: "السحب", value: parsed.draw });
  if (parsed.reference) out.push({ label: "المرجعية", value: parsed.reference });
  return out;
}

function table(d: DesktopInvoicePrint, lines: DesktopInvoiceLine[]): string {
  const sale = d.type === "sale";
  const cols = [
    { key: "fabric", label: "الصنف", width: sale ? "22%" : "20%", cls: "" },
    { key: "color", label: "اللون", width: sale ? "22%" : "20%", cls: "" },
    { key: "roll", label: "رقم الصبغة", width: "12%", cls: "pd-nowrap" },
    { key: "pieces", label: "الأثواب", width: "7%", cls: "pd-center pd-nowrap" },
    {
      key: "qty",
      label: "الكمية (كغ)",
      width: sale ? "10%" : "11%",
      cls: "pd-center pd-nowrap pd-divider-after",
    },
    { key: "price", label: "السعر/كغ", width: "12%", cls: "pd-amount amount-col" },
    { key: "gross", label: "الإجمالي", width: sale ? "15%" : "18%", cls: "pd-amount amount-col" },
  ];
  const head = `<colgroup>${cols.map((c) => `<col style="width:${c.width}">`).join("")}</colgroup><thead><tr>${cols
    .map((c) => `<th class="${c.cls.replace("pd-nowrap", "").trim()}">${c.label}</th>`)
    .join("")}</tr></thead>`;
  const rows: string[] = [];
  for (const l of lines) {
    const roll = l.rollNo ? `#${l.rollNo}` : l.dyeBatch ? l.dyeBatch : "—";
    const cells: Record<string, string> = {
      fabric: e(l.fabric || "—"),
      color: colorCell(l),
      roll: e(roll),
      pieces: l.pieces && l.pieces >= 1 ? String(l.pieces) : "—",
      qty: formatQuantity(l.quantityKg),
      price: formatNumber(l.pricePerKg),
      gross: formatMoney(l.lineTotal),
    };
    rows.push(`<tr>${cols.map((c) => `<td class="${c.cls}">${cells[c.key]}</td>`).join("")}</tr>`);
    const details = lineDetails(l);
    if (details.length > 0) {
      const empty = 4 - (details.length % 4 || 4);
      rows.push(
        `<tr class="print-detail-row"><td colspan="${cols.length}"><div class="pd-detail-grid">${details
          .map(
            (x) =>
              `<div class="pd-detail-item"><span class="pd-detail-label">${e(x.label)}</span><span class="pd-detail-val">${e(
                x.value,
              )}</span></div>`,
          )
          .join(
            "",
          )}${'<div class="pd-detail-item pd-detail-empty"></div>'.repeat(empty)}</div></td></tr>`,
      );
    }
  }
  return `<table class="print-table">${head}<tbody>${rows.join("")}</tbody></table>`;
}

function page(
  d: DesktopInvoicePrint,
  lines: DesktopInvoiceLine[],
  n: number,
  pages: number,
): string {
  const sale = d.type === "sale";
  const first = n === 1;
  const last = n === pages;
  const remaining = Math.max(0, d.total - d.paid);
  const status = d.cancelled ? "ملغاة" : remaining > 0 ? "مفتوحة" : "مدفوعة";
  const meta: Meta[] = [
    { label: "رقم الفاتورة", value: d.reference || d.number },
    { label: "التاريخ", value: d.date },
    { label: "الحالة", value: status },
    { label: "العملة", value: `${d.currency} (${symbol(d.currency)})` },
  ];
  if (d.cancelled && d.cancelledAt) {
    meta.push({
      label: "تاريخ الإلغاء",
      value: String(d.cancelledAt).slice(0, 19).replace("T", " "),
    });
  }
  const rate = Number(d.exchangeRate);
  if (!sale && rate > 0 && String(rate) !== "1") {
    meta.push({
      label: "سعر الصرف",
      value: `${formatNumber(rate)} (بتاريخ ${keepTogether(d.date)})`,
    });
    if (d.currency !== "USD") {
      meta.push({ label: "المعادل بالدولار", value: `$${formatNumber(Number(d.baseTotal) || 0)}` });
    }
  }
  if (d.paymentMethod) {
    meta.push({ label: "طريقة الدفع", value: PAYMENT_LABEL[d.paymentMethod] ?? d.paymentMethod });
  }
  const p = d.party;
  const partyLabel = sale ? "العميل" : "المورّد";
  const address = [p.address, p.city].filter(Boolean).join(" — ");
  const party = `<div class="print-party print-meta-item"><span class="print-meta-label">${partyLabel}</span><span class="print-meta-value print-party-name">${e(
    p.name || (sale ? "عميل غير معرّف" : "مورّد غير معرّف"),
  )}</span>${p.code ? `<span class="print-party-line">الرمز: ${e(p.code)}</span>` : ""}${
    p.phone
      ? `<span class="print-party-line">الهاتف: <span dir="ltr">${e(p.phone)}</span></span>`
      : ""
  }${address ? `<span class="print-party-line">${e(address)}</span>` : ""}</div>`;
  const info = first
    ? `<div class="print-info-grid print-avoid-break">${party}${meta
        .map(
          (m) =>
            `<div class="print-meta-item"><span class="print-meta-label">${e(m.label)}</span><span class="print-meta-value">${e(
              m.value,
            )}</span></div>`,
        )
        .join("")}</div>`
    : "";

  const totals: Array<{ label: string; value: string; grand?: boolean }> = [];
  if (sale) {
    const pieces = d.piecesCount ?? d.lines.reduce((s, l) => s + (l.pieces ?? 1), 0);
    totals.push({ label: "عدد الأثواب", value: formatNumber(pieces) });
  }
  totals.push({ label: "المجموع", value: amount(d.subtotal, d.currency) });
  if (d.discount > 0) totals.push({ label: "الخصم", value: `− ${amount(d.discount, d.currency)}` });
  if (d.tax > 0) totals.push({ label: "الضريبة", value: `+ ${amount(d.tax, d.currency)}` });
  if (d.shipping > 0) totals.push({ label: "الشحن", value: `+ ${amount(d.shipping, d.currency)}` });
  totals.push({ label: "الإجمالي النهائي", value: amount(d.total, d.currency), grand: true });
  const payment = [
    { label: "الإجمالي", value: amount(d.total, d.currency) },
    { label: sale ? "المقبوض" : "المدفوع", value: amount(d.paid, d.currency) },
    { label: sale ? "الباقي" : "المتبقي", value: amount(remaining, d.currency) },
  ];
  const subtitle =
    !first && pages > 1
      ? `تابع — صفحة ${n} من ${pages}`
      : sale
        ? "بيع بضاعة للعميل"
        : "إدخال بضاعة إلى المخزون";

  return `<div class="print-doc" data-paper="A4" data-orientation="portrait">
<div class="print-brand-bar${first ? "" : " print-brand-bar--compact"}"><img class="print-logo" src="${DESKTOP_LOGO_DATA_URI}" alt=""><div class="print-brand-name">${e(
    PRINT_BRAND_NAME,
  )}</div>${
    first
      ? `<div class="print-brand-contact">${FIXED_PRINT_FOOTER_LINES.map(
          (line) => `<div class="print-brand-contact-line">${e(line)}</div>`,
        ).join("")}</div>`
      : ""
  }</div>
<div class="print-header-divider"></div>
<div class="print-masthead"><div class="print-header-title-area"><div class="print-title-row"><span class="print-type-badge print-badge-${
    sale ? "sale" : "purchase"
  }">${sale ? "SALE" : "PURCHASE"}</span><div class="print-doc-title">${
    sale ? "فاتورة بيع" : "فاتورة شراء"
  }</div></div><div class="print-doc-subtitle">${e(subtitle)}</div></div></div>
${info}
${table(d, lines)}
${
  last
    ? `<div class="print-totals print-avoid-break">${totals
        .map(
          (t) =>
            `<div class="print-total-row${t.grand ? " print-grand-total" : ""}"><span>${e(t.label)}</span><span class="pd-amount pd-money" dir="ltr">${e(
              t.value,
            )}</span></div>`,
        )
        .join("")}</div>
<div class="print-payment print-avoid-break">${payment
        .map(
          (x) =>
            `<div class="print-payment-item"><div class="print-payment-label">${e(x.label)}</div><div class="print-payment-value pd-money" dir="ltr">${e(
              x.value,
            )}</div></div>`,
        )
        .join("")}</div>
${d.notes ? `<div class="print-notes print-avoid-break"><span class="print-notes-label">ملاحظات:</span> ${e(d.notes)}</div>` : ""}
<div class="print-signatures print-avoid-break"><div class="print-signature"><div class="print-signature-line">توقيع المستلم</div></div><div class="print-signature"><div class="print-signature-line">ختم الشركة</div></div></div>
<div class="print-footer"><div class="print-footer-thanks">${e(d.footerNote || "شكراً لتعاملكم معنا")}</div></div>`
    : ""
}
</div>`;
}

/** The base styles the desktop puts on its print root, applied to the PDF's body. */
const BODY_CSS = `
html, body { margin: 0; padding: 0; background: #ffffff; }
/* The desktop's print root: its stylesheet hides everything else when printing and parks the root off-screen on
   screen; here the root IS the document, shown in both media. */
[data-print-root] { position: static !important; left: auto !important; top: auto !important; z-index: auto !important;
  pointer-events: auto !important; display: block !important; width: 100% !important; }
[data-print-root] > .print-doc { padding: 12mm 15mm; }
`;

export function renderDesktopInvoiceHtml(d: DesktopInvoicePrint): string {
  const chunks: DesktopInvoiceLine[][] = [];
  for (let i = 0; i < Math.max(d.lines.length, 1); i += LINES_PER_PAGE) {
    chunks.push(d.lines.slice(i, i + LINES_PER_PAGE));
  }
  const pages = chunks
    .map((lines, i) => page(d, lines, i + 1, chunks.length))
    .join(`<div class="print-page-break" aria-hidden="true"></div>`);
  return `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><title>${e(
    d.number,
  )}</title><style>${DESKTOP_PRINT_CSS}${BODY_CSS}</style></head><body><div data-print-root data-paper="A4">${pages}</div></body></html>`;
}
