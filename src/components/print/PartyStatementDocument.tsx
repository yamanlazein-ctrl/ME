import type { ReactNode } from "react";
import {
  PrintDocument,
  PrintTable,
  type PrintColumn,
  type PrintMetaItem,
} from "@/components/print/PrintDocument";
import { LEDGER_TYPE_LABEL } from "@/presentation/hooks/useLedger";
import { formatMoney, formatQuantity } from "@/shared/utils/formatNumber";

const fmtMoney = (n: number) => formatMoney(n);
const fmtQty = (n: number) => formatQuantity(n);

export type StatementRow = {
  seq: number;
  date: string;
  type: string;
  referenceNumber?: string | null;
  description: string;
  quantityKg?: number;
  pricePerKg?: number;
  debit: number;
  credit: number;
  runningBalance: number;
  status?: "active" | "cancelled";
};

export function PartyStatementDocument({
  partyName,
  partyCode,
  period,
  currency,
  previousBalance,
  rows,
  totals,
}: {
  partyName: string;
  partyCode?: string;
  period: string;
  currency: string;
  previousBalance: number;
  rows: StatementRow[];
  totals: { debit: number; credit: number; running: number };
}) {
  const meta: PrintMetaItem[] = [
    { label: "الطرف", value: partyName },
    { label: "الرمز", value: partyCode || "—" },
    { label: "الفترة", value: period },
    { label: "العملة", value: currency },
  ];

  const columns: PrintColumn[] = [
    { key: "seq", label: "#", width: "4%" },
    { key: "date", label: "التاريخ", width: "10%" },
    { key: "type", label: "النوع", width: "12%" },
    { key: "ref", label: "المرجع", width: "12%" },
    { key: "desc", label: "البيان", width: "22%" },
    { key: "qty", label: "الكمية", align: "left", width: "9%" },
    { key: "price", label: "السعر", align: "left", amount: true, width: "9%" },
    { key: "debit", label: "مدين", align: "left", amount: true, width: "10%" },
    { key: "credit", label: "دائن", align: "left", amount: true, width: "10%" },
    { key: "bal", label: "الرصيد", align: "left", amount: true, width: "12%" },
  ];



  const tableRows: (string | ReactNode)[][] = [];
  if (previousBalance !== 0 || rows.length > 0) {
    tableRows.push([
      "—",
      "—",
      "رصيد سابق",
      "—",
      "أرصدة قبل تاريخ البداية",
      "—",
      "—",
      "—",
      "—",
      fmtMoney(previousBalance),
    ]);
  }

  const cancelled = (r: StatementRow) => r.status === "cancelled";
  const cell = (content: string | number, muted: boolean): string | ReactNode =>
    muted ? (
      <span style={{ textDecoration: "line-through", color: "#b0b0b0" }}>{content}</span>
    ) : (
      content
    );

  rows.forEach((r) => {
    const m = cancelled(r);
    tableRows.push([
      cell(String(r.seq), m),
      cell(r.type === "opening" ? "—" : r.date, m),
      cell(
        `${LEDGER_TYPE_LABEL[r.type] ?? r.type}${m ? " (ملغاة)" : ""}`,
        m,
      ),
      cell(r.referenceNumber ?? "—", m),
      cell(r.description, m),
      cell(r.quantityKg ? `${fmtQty(r.quantityKg)} كجم` : "—", m),
      cell(r.pricePerKg ? fmtMoney(r.pricePerKg) : "—", m),
      cell(r.debit ? fmtMoney(r.debit) : "—", m),
      cell(r.credit ? fmtMoney(r.credit) : "—", m),
      cell(fmtMoney(r.runningBalance), m),
    ]);
  });

  const totalsList = [
    { label: "رصيد سابق", value: `${fmtMoney(previousBalance)} ${currency}`, grand: false },
    { label: "إجمالي مدين", value: `${fmtMoney(totals.debit)} ${currency}`, grand: false },
    { label: "إجمالي دائن", value: `${fmtMoney(totals.credit)} ${currency}`, grand: false },
    { label: "الرصيد النهائي", value: `${fmtMoney(totals.running)} ${currency}`, grand: true },
  ];

  return (
    <PrintDocument
      title="كشف حساب"
      subtitle={partyName}
      meta={meta}
      totals={totalsList}
      signatures={["إعداد", "اعتماد"]}
    >
      {tableRows.length === 0 ? (
        <div style={{ padding: "12pt 0 4pt", fontSize: "9pt", color: "#666" }}>
          لا توجد حركات في هذه الفترة.
        </div>
      ) : (
        <PrintTable columns={columns} rows={tableRows} />
      )}
    </PrintDocument>
  );
}
