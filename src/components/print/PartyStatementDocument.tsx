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
  /** Symbol of the row's ledger currency (shown in multi-currency statements). */
  currencySymbol?: string;
  /** Document amount in the currency it was entered in, e.g. "10 $". */
  originalAmount?: string | null;
  /** Rate frozen on the document (payment-time rate for cross-currency payments). */
  exchangeRate?: string | null;
  /** How a payment was applied: rate × amount = equivalent → invoice. */
  paymentNote?: string | null;
};

export type StatementCurrencyTotals = {
  symbol: string;
  debit: number;
  credit: number;
  running: number;
};

export function PartyStatementDocument({
  partyName,
  partyCode,
  period,
  currency,
  previousBalance,
  rows,
  totals,
  totalsByCurrency,
}: {
  partyName: string;
  partyCode?: string;
  period: string;
  currency: string;
  previousBalance: number;
  rows: StatementRow[];
  totals: { debit: number; credit: number; running: number };
  /** Multi-currency statements list one totals block per currency instead of a blended 0. */
  totalsByCurrency?: StatementCurrencyTotals[];
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
    { key: "desc", label: "البيان", width: "18%" },
    { key: "orig", label: "المبلغ الأصلي", align: "left", width: "9%" },
    { key: "rate", label: "سعر الصرف", align: "left", width: "7%" },
    { key: "qty", label: "الكمية", align: "center", width: "6%" },
    { key: "price", label: "السعر", align: "left", amount: true, width: "7%" },
    { key: "debit", label: "مدين", align: "left", amount: true, width: "9%" },
    { key: "credit", label: "دائن", align: "left", amount: true, width: "9%" },
    { key: "bal", label: "الرصيد", align: "left", amount: true, width: "9%" },
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
      cell(`${LEDGER_TYPE_LABEL[r.type] ?? r.type}${m ? " (ملغاة)" : ""}`, m),
      cell(r.referenceNumber ?? "—", m),
      cell(r.paymentNote ? `${r.description} — ${r.paymentNote}` : r.description, m),
      cell(r.originalAmount ?? "—", m),
      cell(r.exchangeRate ?? "—", m),
      cell(r.quantityKg ? `${fmtQty(r.quantityKg)} كجم` : "—", m),
      cell(r.pricePerKg ? fmtMoney(r.pricePerKg) : "—", m),
      cell(r.debit ? fmtMoney(r.debit) : "—", m),
      cell(r.credit ? fmtMoney(r.credit) : "—", m),
      cell(`${fmtMoney(r.runningBalance)}${r.currencySymbol ? ` ${r.currencySymbol}` : ""}`, m),
    ]);
  });

  const totalsList = totalsByCurrency
    ? totalsByCurrency.flatMap((t) => [
        {
          label: `إجمالي مدين — ${t.symbol}`,
          value: `${fmtMoney(t.debit)} ${t.symbol}`,
          grand: false,
        },
        {
          label: `إجمالي دائن — ${t.symbol}`,
          value: `${fmtMoney(t.credit)} ${t.symbol}`,
          grand: false,
        },
        {
          label: `الرصيد النهائي — ${t.symbol}`,
          value: `${fmtMoney(t.running)} ${t.symbol}`,
          grand: true,
        },
      ])
    : [
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
      typeBadge="STATEMENT"
    >
      {tableRows.length === 0 ? (
        <div
          style={{ padding: "16pt 0 8pt", fontSize: "9.5pt", color: "#666", textAlign: "center" }}
        >
          لا توجد حركات في هذه الفترة.
        </div>
      ) : (
        <PrintTable columns={columns} rows={tableRows} />
      )}
    </PrintDocument>
  );
}
