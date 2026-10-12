/**
 * Exporters: turn persisted ERP records into CSV archive content.
 *
 * Rules (per the master brief):
 * - Only fields that exist in the real schema (verified against
 *   orm/sqlite/schemas/*.table.ts). No invented columns, no confidential
 *   fields beyond what the business page itself shows (notesPrint is the
 *   print-facing notes; notesInternal is excluded from customer-facing
 *   exports).
 * - UTF-8 BOM so Excel renders Arabic correctly.
 * - Business-date (`date` column) filtering, not created_at.
 * - Cancelled documents are INCLUDED with a cancelled marker: the archive
 *   must reflect reality, and cancellation is a business fact.
 * - Totals are re-summable from the emitted rows (verified in tests).
 */
import { and, eq, gte, lt } from "drizzle-orm";
import { invoices } from "../orm/sqlite/schemas/invoice.table.js";
import { parties } from "../orm/sqlite/schemas/party.table.js";
import { returns } from "../orm/sqlite/schemas/return.table.js";
import { expenses } from "../orm/sqlite/schemas/expense.table.js";
import type { DB } from "../orm/sqlite/drizzleCompat.js";

/** UTF-8 BOM + CSV body. Columns are simple; quotes per RFC 4180. */
export function toCsv(headers: string[], rows: Array<Array<string | number | null>>): Uint8Array {
  const esc = (v: string | number | null): string => {
    if (v === null || v === undefined) return "";
    const s = String(v);
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [headers.map(esc).join(",")];
  for (const r of rows) lines.push(r.map(esc).join(","));
  // \r\n per RFC 4180; BOM first.
  return new TextEncoder().encode(`\uFEFF${lines.join("\r\n")}\r\n`);
}

function periodRange(periodKey: string): { from: string; to: string } {
  const [y, m] = periodKey.split("-").map(Number);
  const from = `${periodKey}-01`;
  const next = m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, "0")}-01`;
  return { from, to: next };
}

export type ExportRow = {
  fileName: string;
  mimeType: string;
  content: Uint8Array;
  /** Emitted data rows (for total verification against source). */
  rowCount: number;
};

const INV_TYPE_SECTION: Record<string, { section: string; label: string }> = {
  sale: { section: "salesInvoices", label: "فواتير البيع" },
  entry: { section: "purchaseInvoices", label: "فواتير الشراء" },
};

export class Exporters {
  constructor(private readonly db: DB) {}

  private partyNameById = new Map<string, string>();

  private async loadParties(): Promise<void> {
    if (this.partyNameById.size) return;
    const rows = await this.db.select({ id: parties.id, name: parties.name }).from(parties);
    for (const p of rows) this.partyNameById.set(p.id, p.name);
  }

  private sectionFor(invType: string): { section: string; label: string } | null {
    return INV_TYPE_SECTION[invType] ?? null;
  }

  /**
   * Export invoices of one type for a period. Returns one ExportRow per
   * invoice (deterministic filename: date_number_party). Unknown invoice
   * types (none today) are skipped — never exported under a wrong section.
   */
  async invoicesForPeriod(periodKey: string, invType: "sale" | "entry"): Promise<ExportRow[]> {
    const target = this.sectionFor(invType);
    if (!target) return [];
    await this.loadParties();
    const { from, to } = periodRange(periodKey);
    const rows = await this.db
      .select({
        id: invoices.id,
        number: invoices.number,
        date: invoices.date,
        partyId: invoices.partyId,
        total: invoices.total,
        paid: invoices.paid,
        status: invoices.status,
      })
      .from(invoices)
      .where(and(eq(invoices.type, invType), gte(invoices.date, from), lt(invoices.date, to)));

    return rows.map((r) => {
      const party = this.partyNameById.get(r.partyId) ?? "";
      const cancelled = r.status === "cancelled";
      const csv = toCsv(
        ["رقم الفاتورة", "التاريخ", "العميل/المورد", "الإجمالي", "المدفوع", "الحالة"],
        [[r.number, r.date, party, r.total, r.paid, cancelled ? "ملغاة" : "نشطة"]],
      );
      return {
        fileName: `${r.date}_${r.number}_${party || "بدون-اسم"}${cancelled ? "_ملغاة" : ""}.csv`,
        mimeType: "text/csv;charset=utf-8",
        content: csv,
        rowCount: 1,
      };
    });
  }

  /** One CSV for all expenses of the month. */
  async expensesForPeriod(periodKey: string): Promise<ExportRow[]> {
    const { from, to } = periodRange(periodKey);
    const rows = await this.db
      .select({
        number: expenses.number,
        date: expenses.date,
        category: expenses.category,
        description: expenses.description,
        amount: expenses.amount,
        method: expenses.method,
        status: expenses.status,
      })
      .from(expenses)
      .where(and(gte(expenses.date, from), lt(expenses.date, to)));
    if (!rows.length) return [];
    const csv = toCsv(
      ["الرقم", "التاريخ", "التصنيف", "الوصف", "المبلغ", "طريقة الدفع", "الحالة"],
      rows.map((r) => [
        r.number,
        r.date,
        r.category,
        r.description,
        r.amount,
        r.method,
        r.status === "cancelled" ? "ملغاة" : "نشطة",
      ]),
    );
    return [
      {
        fileName: `${periodKey}-01_مصروفات-الشهر.csv`,
        mimeType: "text/csv;charset=utf-8",
        content: csv,
        rowCount: rows.length,
      },
    ];
  }
}
