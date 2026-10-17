/**
 * Excel (CSV) export of the central ledger. Pure: the rows are turned into lines here, and the page
 * only supplies the data and triggers the download. Zero rows still produce the header line.
 */
import { LEDGER_TYPE_LABEL, type LedgerType } from "@/presentation/hooks/useLedger";
import { formatDateTime } from "@/lib/utils";
import type { LedgerPrintRow } from "@/components/print/LedgerPrintDocument";

export const LEDGER_EXPORT_HEADERS = [
  "التاريخ",
  "النوع",
  "الوصف",
  "المرجع",
  "الطرف",
  "العملة",
  "مدين",
  "دائن",
  "الصندوق",
  "الحالة",
] as const;

const CASH: Record<string, string> = { in: "وارد", out: "صادر", none: "" };

/** A number as plain text with two decimals (no thousands separator: spreadsheets parse it). */
export function exportAmount(n: number): string {
  return n ? n.toFixed(2) : "";
}

/** Header first, then one line per row. Rows keep the screen's order. */
export function ledgerExportLines(rows: LedgerPrintRow[]): string[][] {
  const lines: string[][] = [[...LEDGER_EXPORT_HEADERS]];
  for (const r of rows) {
    lines.push([
      formatDateTime(r.createdAt),
      LEDGER_TYPE_LABEL[r.type as LedgerType] ?? r.type,
      r.description,
      r.referenceNumber ?? "",
      r.partyName,
      r.currency,
      exportAmount(r.debit),
      exportAmount(r.credit),
      CASH[r.cashImpact] ?? "",
      r.status === "cancelled" ? "ملغاة" : "نشطة",
    ]);
  }
  return lines;
}

/** A UTF-8 CSV with a BOM, so Excel reads Arabic correctly. Quotes every field. */
export function ledgerExportCsv(rows: LedgerPrintRow[]): string {
  const body = ledgerExportLines(rows)
    .map((line) => line.map((c) => `"${String(c).replaceAll('"', '""')}"`).join(","))
    .join("\r\n");
  return "\ufeff" + body + "\r\n";
}
