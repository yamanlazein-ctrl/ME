/**
 * Phase 3 — pure HTML builders for the archive PDFs (no React, no hooks, no I/O).
 *
 * The desktop renders these documents to PDF in the background (`pdf_render.rs`). The layout reuses the
 * print CSS classes and the Arabic font rules of the existing archive HTML (`ARCHIVE_ARABIC_FONT_CSS`,
 * `pageRuleCss`), so an archived document matches what the user prints.
 *
 * Money rules (CLAUDE.md): totals are never recomputed from display strings. Amounts come from the
 * stored document values; sums go through `round2dp`. Party names and notes are user input and are
 * always HTML-escaped.
 */
import { round2dp } from "./precision.js";
import { ARCHIVE_ARABIC_FONT_CSS, pageRuleCss } from "./archivePageCss.js";

/** Escape user-controlled text for HTML. Every interpolated value passes through here. */
export function escapeHtml(value: string | number | null | undefined): string {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export type ArchivePaper = "A4" | "A5";

/**
 * A complete, self-contained RTL document around one rendered body. No scripts, no external
 * resources: the PDF renderer loads it from memory.
 */
export function wrapArchiveDocument(opts: {
  title: string;
  bodyHtml: string;
  paper: ArchivePaper;
  landscape?: boolean;
}): string {
  const orientation = opts.landscape ? "landscape" : "portrait";
  return `<!DOCTYPE html>
<html lang="ar" dir="rtl" data-paper="${opts.paper}">
<head>
<meta charset="utf-8" />
<title>${escapeHtml(opts.title)}</title>
<style>
  ${pageRuleCss(opts.paper, orientation)}
  body { background: #fff; margin: 0; }
  ${ARCHIVE_ARABIC_FONT_CSS}
  .arc-table { width: 100%; border-collapse: collapse; font-size: 11px; }
  .arc-table th, .arc-table td { border: 1px solid #999; padding: 3px 5px; }
  .arc-table th { background: #eee; font-weight: 600; }
  .arc-num { text-align: left; direction: ltr; white-space: nowrap; }
  .arc-muted { color: #666; }
  .arc-title { font-size: 16px; font-weight: 700; margin: 0 0 6px; }
  .arc-meta { display: flex; flex-wrap: wrap; gap: 4px 16px; font-size: 11px; margin-bottom: 8px; }
  .arc-cancelled td { color: #888; text-decoration: line-through; }
</style>
</head>
<body>
<div data-print-root>${opts.bodyHtml}</div>
</body>
</html>`;
}

/** Money as the archive shows it. Rounded to 2 dp with the shared helper, never `Math.round(x*100)`. */
export function fmtMoney(n: number | string | null | undefined): string {
  const v = round2dp(Number(n ?? 0));
  return Number.isFinite(v) ? v.toFixed(2) : "0.00";
}

/** Quantity in kilograms, 2 dp. */
export function fmtKg(n: number | string | null | undefined): string {
  return fmtMoney(n);
}

// ── Invoices ─────────────────────────────────────────────────────────────

export type ArchiveInvoiceLine = {
  fabric: string;
  color: string;
  rollNo: string;
  pieces: number | null;
  quantityKg: number;
  pricePerKg: number;
  discountAmount: number;
  /** Line total as stored on the document (gross − discount). */
  lineTotal: number;
  note?: string | null;
};

export type ArchiveInvoiceHeader = {
  kind: "entry" | "sale";
  number: string;
  date: string;
  partyName: string;
  currency: string;
  subtotal: number;
  discount: number;
  tax: number;
  shipping: number;
  total: number;
  paid: number;
  cancelled: boolean;
  notes?: string | null;
};

const INVOICE_TITLE: Record<ArchiveInvoiceHeader["kind"], string> = {
  entry: "فاتورة دخول (شراء)",
  sale: "فاتورة خروج (بيع)",
};

/**
 * Invoice body: header, party, every roll line, totals and the paid/remaining summary. A cancelled
 * document is printed with its status, never hidden.
 */
export function buildInvoiceBody(
  header: ArchiveInvoiceHeader,
  lines: ArchiveInvoiceLine[],
): string {
  const remaining = round2dp(Math.max(0, Number(header.total) - Number(header.paid)));
  const rows = lines
    .map(
      (l) => `<tr class="${header.cancelled ? "arc-cancelled" : ""}">
  <td>${escapeHtml(l.fabric)}</td>
  <td>${escapeHtml(l.color)}</td>
  <td>${escapeHtml(l.rollNo)}</td>
  <td class="arc-num">${l.pieces ?? "—"}</td>
  <td class="arc-num">${fmtKg(l.quantityKg)}</td>
  <td class="arc-num">${fmtMoney(l.pricePerKg)}</td>
  <td class="arc-num">${fmtMoney(l.discountAmount)}</td>
  <td class="arc-num">${fmtMoney(l.lineTotal)}</td>
  <td>${escapeHtml(l.note ?? "")}</td>
</tr>`,
    )
    .join("\n");
  const totalKg = round2dp(lines.reduce((s, l) => s + Number(l.quantityKg || 0), 0));
  return `
<h1 class="arc-title">${INVOICE_TITLE[header.kind]} — ${escapeHtml(header.number)}${header.cancelled ? " (ملغاة)" : ""}</h1>
<div class="arc-meta">
  <span>التاريخ: ${escapeHtml(header.date)}</span>
  <span>الطرف: ${escapeHtml(header.partyName)}</span>
  <span>العملة: ${escapeHtml(header.currency)}</span>
</div>
<table class="arc-table">
  <thead><tr>
    <th>الصنف</th><th>اللون</th><th>رقم الصبغة</th><th>الأثواب</th>
    <th>الكمية (كغ)</th><th>السعر/كغ</th><th>الخصم</th><th>الإجمالي</th><th>ملاحظة</th>
  </tr></thead>
  <tbody>
${rows}
  </tbody>
  <tfoot><tr>
    <td colspan="4">عدد الأسطر: ${lines.length}</td>
    <td class="arc-num">${fmtKg(totalKg)}</td>
    <td colspan="3">المجموع الفرعي</td>
    <td class="arc-num">${fmtMoney(header.subtotal)}</td>
    <td></td>
  </tr></tfoot>
</table>
<table class="arc-table" style="width: 45%; margin-top: 8px;">
  <tbody>
    <tr><td>الخصم</td><td class="arc-num">${fmtMoney(header.discount)}</td></tr>
    <tr><td>الضريبة</td><td class="arc-num">${fmtMoney(header.tax)}</td></tr>
    <tr><td>الشحن</td><td class="arc-num">${fmtMoney(header.shipping)}</td></tr>
    <tr><td><strong>الإجمالي</strong></td><td class="arc-num"><strong>${fmtMoney(header.total)}</strong></td></tr>
    <tr><td>المدفوع</td><td class="arc-num">${fmtMoney(header.paid)}</td></tr>
    <tr><td>المتبقي</td><td class="arc-num">${fmtMoney(remaining)}</td></tr>
  </tbody>
</table>
${header.notes ? `<p class="arc-muted">ملاحظات: ${escapeHtml(header.notes)}</p>` : ""}`;
}

// ── Statements (customer / supplier) ─────────────────────────────────────

export type ArchiveLeg = {
  /** Business date, `YYYY-MM-DD`. */
  date: string;
  /** Creation time of the ledger row (ISO). Tie-breaker after the date. */
  createdAt: string;
  /** Document rank: invoices and returns before the payments booked with them (CLAUDE.md). */
  docRank: number;
  id: string;
  type: string;
  reference: string;
  description: string;
  debit: number;
  credit: number;
  status: "active" | "cancelled";
};

/**
 * Statement order `(date, createdAt, docRank, id)`. This is the documented order (CLAUDE.md "Statement
 * order") and must match the statement cursor predicates. A new array is returned; the input is not
 * mutated.
 */
export function orderStatementLegs(legs: ArchiveLeg[]): ArchiveLeg[] {
  return [...legs].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.docRank - b.docRank ||
      a.id.localeCompare(b.id),
  );
}

/**
 * Running balance over ordered legs. Only ACTIVE legs move the balance; a cancelled leg is printed
 * (so the reader sees it) but contributes nothing. Sums use `round2dp` at each step.
 */
export function runningBalances(
  legs: ArchiveLeg[],
  opening: number,
): Array<ArchiveLeg & { balance: number }> {
  let balance = round2dp(opening);
  return legs.map((leg) => {
    if (leg.status === "active") {
      balance = round2dp(balance + Number(leg.debit || 0) - Number(leg.credit || 0));
    }
    return { ...leg, balance };
  });
}

export function buildStatementBody(opts: {
  partyName: string;
  partyKind: "customer" | "supplier";
  currency: string;
  periodFrom: string;
  periodTo: string;
  opening: number;
  legs: ArchiveLeg[];
}): string {
  const ordered = runningBalances(orderStatementLegs(opts.legs), opts.opening);
  const totalDebit = round2dp(
    ordered.reduce((s, l) => s + (l.status === "active" ? l.debit : 0), 0),
  );
  const totalCredit = round2dp(
    ordered.reduce((s, l) => s + (l.status === "active" ? l.credit : 0), 0),
  );
  const closing = ordered.length ? ordered[ordered.length - 1].balance : round2dp(opts.opening);
  const kind = opts.partyKind === "customer" ? "كشف حساب عميل" : "كشف حساب مورد";
  const rows = ordered
    .map(
      (l) => `<tr class="${l.status === "cancelled" ? "arc-cancelled" : ""}">
  <td class="arc-num">${escapeHtml(l.date)}</td>
  <td>${escapeHtml(l.type)}</td>
  <td>${escapeHtml(l.reference)}</td>
  <td>${escapeHtml(l.description)}${l.status === "cancelled" ? " (ملغى)" : ""}</td>
  <td class="arc-num">${fmtMoney(l.debit)}</td>
  <td class="arc-num">${fmtMoney(l.credit)}</td>
  <td class="arc-num">${fmtMoney(l.balance)}</td>
</tr>`,
    )
    .join("\n");
  return `
<h1 class="arc-title">${kind} — ${escapeHtml(opts.partyName)}</h1>
<div class="arc-meta">
  <span>الفترة: ${escapeHtml(opts.periodFrom)} → ${escapeHtml(opts.periodTo)}</span>
  <span>العملة: ${escapeHtml(opts.currency)}</span>
  <span>الرصيد الافتتاحي: ${fmtMoney(opts.opening)}</span>
</div>
<table class="arc-table">
  <thead><tr>
    <th>التاريخ</th><th>النوع</th><th>المرجع</th><th>البيان</th>
    <th>مدين</th><th>دائن</th><th>الرصيد</th>
  </tr></thead>
  <tbody>
${rows}
  </tbody>
  <tfoot><tr>
    <td colspan="4">الإجمالي</td>
    <td class="arc-num">${fmtMoney(totalDebit)}</td>
    <td class="arc-num">${fmtMoney(totalCredit)}</td>
    <td class="arc-num">${fmtMoney(closing)}</td>
  </tr></tfoot>
</table>`;
}

// ── Cashbox ledger report ─────────────────────────────────────────────────

export type ArchiveCashRow = {
  date: string;
  createdAt: string;
  docRank: number;
  id: string;
  type: string;
  description: string;
  currency: string;
  cashIn: number;
  cashOut: number;
  status: "active" | "cancelled";
};

/**
 * A ledger leg as the archive reads it. Structural (not the domain entity) so the mapper is a pure
 * function that a test can drive without a store or a backend.
 */
export type ArchiveCashLeg = {
  id?: string | null;
  date: string;
  createdAt?: string | null;
  type: string;
  description?: string | null;
  currency: string;
  debit?: number | null;
  credit?: number | null;
  cashImpact: "in" | "out" | "none";
  status?: string | null;
};

/**
 * Map ledger legs to the archive's cashbox rows.
 *
 * The amount of a cash leg is debit + credit — exactly how the server computes it
 * (cashboxBalanceHelper.ts: COALESCE(debit,0) + COALESCE(credit,0)). A cash-OUT leg is a CREDIT
 * entry: debit is 0 and credit holds the amount. `debit ?? credit` therefore read the 0 (?? only
 * falls through on null/undefined, never on 0) and reported every outflow as 0.00 — a misstated
 * cashbox in a financial document.
 */
export function toArchiveCashRows(legs: readonly ArchiveCashLeg[]): ArchiveCashRow[] {
  return legs
    .filter((e) => e.cashImpact === "in" || e.cashImpact === "out")
    .map((e, i) => {
      const amount = Math.abs(Number(e.debit ?? 0) + Number(e.credit ?? 0));
      return {
        date: e.date,
        createdAt: e.createdAt ?? "",
        docRank: 1,
        id: e.id ?? String(i),
        type: e.type,
        description: e.description ?? "",
        currency: e.currency,
        cashIn: e.cashImpact === "in" ? amount : 0,
        cashOut: e.cashImpact === "out" ? amount : 0,
        status: e.status === "cancelled" ? "cancelled" : "active",
      };
    });
}

/**
 * Cashbox ledger for one month, grouped per currency. Money is never added across currencies: each
 * currency gets its own totals and closing balance.
 */
export function buildCashboxBody(opts: {
  period: string;
  rows: ArchiveCashRow[];
  openingByCurrency: Record<string, number>;
}): string {
  const byCurrency = new Map<string, ArchiveCashRow[]>();
  for (const r of [...opts.rows].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.createdAt.localeCompare(b.createdAt) ||
      a.docRank - b.docRank ||
      a.id.localeCompare(b.id),
  )) {
    const list = byCurrency.get(r.currency) ?? [];
    list.push(r);
    byCurrency.set(r.currency, list);
  }
  const currencies = [
    ...new Set([...byCurrency.keys(), ...Object.keys(opts.openingByCurrency)]),
  ].sort();
  const sections = currencies
    .map((cur) => {
      const rows = byCurrency.get(cur) ?? [];
      let balance = round2dp(opts.openingByCurrency[cur] ?? 0);
      const opening = balance;
      let totalIn = 0;
      let totalOut = 0;
      const body = rows
        .map((r) => {
          if (r.status === "active") {
            balance = round2dp(balance + Number(r.cashIn || 0) - Number(r.cashOut || 0));
            totalIn = round2dp(totalIn + Number(r.cashIn || 0));
            totalOut = round2dp(totalOut + Number(r.cashOut || 0));
          }
          return `<tr class="${r.status === "cancelled" ? "arc-cancelled" : ""}">
  <td class="arc-num">${escapeHtml(r.date)}</td>
  <td>${escapeHtml(r.type)}</td>
  <td>${escapeHtml(r.description)}${r.status === "cancelled" ? " (ملغى)" : ""}</td>
  <td class="arc-num">${fmtMoney(r.cashIn)}</td>
  <td class="arc-num">${fmtMoney(r.cashOut)}</td>
  <td class="arc-num">${fmtMoney(balance)}</td>
</tr>`;
        })
        .join("\n");
      return `<h2 class="arc-title">الصندوق — ${escapeHtml(cur)}</h2>
<div class="arc-meta">
  <span>الرصيد الافتتاحي: ${fmtMoney(opening)}</span>
  <span>الوارد: ${fmtMoney(totalIn)}</span>
  <span>الصادر: ${fmtMoney(totalOut)}</span>
  <span>الرصيد الختامي: ${fmtMoney(balance)}</span>
</div>
<table class="arc-table">
  <thead><tr><th>التاريخ</th><th>النوع</th><th>البيان</th><th>وارد</th><th>صادر</th><th>الرصيد</th></tr></thead>
  <tbody>
${body}
  </tbody>
</table>`;
    })
    .join("\n");
  return `
<h1 class="arc-title">تقرير الصندوق — ${escapeHtml(opts.period)}</h1>
${sections || '<p class="arc-muted">لا توجد حركات في هذه الفترة.</p>'}`;
}
