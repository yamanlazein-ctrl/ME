import type { ReactNode } from "react";
import { PrintDocument, PrintTable, type PrintColumn } from "@/components/print/PrintDocument";
import { Money } from "@/components/print/PrintMoney";
import { LEDGER_TYPE_LABEL, type LedgerType } from "@/presentation/hooks/useLedger";
import { formatDateTime } from "@/lib/utils";
import { currencySymbol } from "@/presentation/hooks/useCurrency";

/** One row of the central ledger, as the page shows it. */
export type LedgerPrintRow = {
  id: string;
  createdAt: string;
  type: string;
  description: string;
  referenceNumber?: string | null;
  partyName: string;
  debit: number;
  credit: number;
  currency: string;
  cashImpact: string;
  status: string;
};

const columns: PrintColumn[] = [
  { key: "date", label: "التاريخ", nowrap: true, width: "10%" },
  { key: "type", label: "النوع", nowrap: true, width: "10%" },
  { key: "desc", label: "الوصف", wrap: true, width: "24%" },
  { key: "ref", label: "المرجع", nowrap: true, width: "8%" },
  { key: "party", label: "الطرف", wrap: true, width: "15%" },
  { key: "debit", label: "مدين", align: "left", amount: true, width: "12%" },
  { key: "credit", label: "دائن", align: "left", amount: true, width: "12%" },
  { key: "cash", label: "الصندوق", align: "center", nowrap: true, width: "5%" },
  { key: "status", label: "الحالة", align: "center", nowrap: true, width: "4%" },
];

const CASH_LABEL: Record<string, string> = { in: "وارد", out: "صادر", none: "—" };

/** The app's Arabic currency symbol (ل.س / $ / €) — never the raw ISO code on a printed line. */
function symbolOf(code: string): string {
  return currencySymbol(code as "SYP" | "USD" | "EUR");
}

/**
 * Printed central ledger: the rows currently filtered on screen (all pages), with the standard
 * ERP header, the filter summary, and per-currency debit/credit totals.
 * Amounts are never added across currencies.
 */
export function LedgerPrintDocument({
  rows,
  filterSummary,
  dateLabel,
}: {
  rows: LedgerPrintRow[];
  filterSummary: string;
  dateLabel: string;
}) {
  const tableRows: (string | ReactNode)[][] = rows.map((r) => {
    const muted = r.status === "cancelled";
    const text = (v: string) => (muted ? <s style={{ color: "#999" }}>{v}</s> : v);
    return [
      text(formatDateTime(r.createdAt)),
      text(LEDGER_TYPE_LABEL[r.type as LedgerType] ?? r.type),
      text(r.description),
      text(r.referenceNumber ?? "—"),
      text(r.partyName),
      r.debit ? <Money amount={r.debit} symbol={symbolOf(r.currency)} /> : "—",
      r.credit ? <Money amount={r.credit} symbol={symbolOf(r.currency)} /> : "—",
      CASH_LABEL[r.cashImpact] ?? "—",
      muted ? "ملغاة" : "نشطة",
    ];
  });

  // Totals per currency: debit and credit of the ACTIVE rows only.
  const byCurrency = new Map<string, { debit: number; credit: number }>();
  for (const r of rows) {
    if (r.status !== "active") continue;
    const t = byCurrency.get(r.currency) ?? { debit: 0, credit: 0 };
    t.debit += r.debit;
    t.credit += r.credit;
    byCurrency.set(r.currency, t);
  }
  const totals = [...byCurrency.entries()].flatMap(([ccy, t]) => [
    {
      label: `إجمالي مدين ${symbolOf(ccy)}`,
      value: <Money amount={t.debit} />,
    },
    {
      label: `إجمالي دائن ${symbolOf(ccy)}`,
      value: <Money amount={t.credit} />,
    },
  ]);

  return (
    <PrintDocument
      title="دفتر الحركات المركزي"
      subtitle={filterSummary}
      meta={[
        { label: "التاريخ", value: dateLabel },
        { label: "عدد الحركات", value: String(rows.length) },
      ]}
      totals={totals.length > 0 ? totals : undefined}
      signatures={["إعداد", "اعتماد"]}
      orientation="landscape"
    >
      {tableRows.length === 0 ? (
        <div
          style={{ padding: "16pt 0 8pt", fontSize: "9.5pt", color: "#666", textAlign: "center" }}
        >
          لا حركات مطابقة للفلاتر.
        </div>
      ) : (
        <PrintTable columns={columns} rows={tableRows} />
      )}
    </PrintDocument>
  );
}
