import type { ReactNode } from "react";
import {
  PrintDocument,
  PrintTable,
  type PrintColumn,
  type PrintMetaItem,
} from "@/components/print/PrintDocument";
import { LEDGER_TYPE_LABEL } from "@/presentation/hooks/useLedger";
import { formatQuantity } from "@/shared/utils/formatNumber";
import { Money } from "@/components/print/PrintMoney";

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
  /** The statement currency's symbol, or "متعدد" for an all-currencies statement. */
  currency: string;
  previousBalance: number;
  rows: StatementRow[];
  totals: { debit: number; credit: number; running: number };
  /** Multi-currency statements list one totals block per currency instead of a blended 0. */
  totalsByCurrency?: StatementCurrencyTotals[];
}) {
  const multi = Boolean(totalsByCurrency);
  const meta: PrintMetaItem[] = [
    { label: "الطرف", value: partyName },
    { label: "الرمز", value: partyCode || "—" },
    { label: "الفترة", value: period },
    { label: "العملة", value: currency },
  ];

  // Proportions sum to 100%. The table is fixed-layout, so these widths are honoured; the
  // description (البيان) takes the flexible share and wraps between words.
  const columns: PrintColumn[] = [
    { key: "seq", label: "#", align: "center", nowrap: true, width: "4%" },
    { key: "date", label: "التاريخ", nowrap: true, width: "9%" },
    { key: "type", label: "النوع", nowrap: true, width: "8%" },
    { key: "ref", label: "المرجع", nowrap: true, width: "8%" },
    { key: "desc", label: "البيان", wrap: true, width: "19%" },
    { key: "orig", label: "المبلغ الأصلي", align: "left", nowrap: true, width: "9%" },
    { key: "rate", label: "سعر الصرف", align: "left", nowrap: true, width: "7%" },
    { key: "qty", label: "الكمية", align: "center", nowrap: true, width: "7%" },
    { key: "price", label: "السعر", align: "left", amount: true, width: "7%" },
    { key: "debit", label: "مدين", align: "left", amount: true, width: "7%" },
    { key: "credit", label: "دائن", align: "left", amount: true, width: "7%" },
    { key: "bal", label: "الرصيد", align: "left", amount: true, width: "8%" },
  ];

  const tableRows: (string | ReactNode)[][] = [];
  // A single "previous balance" figure only exists per currency; an all-currencies statement shows
  // each currency's running balance on its own rows instead of a blended number.
  if (!multi && (previousBalance !== 0 || rows.length > 0)) {
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
      <Money key="prev" amount={previousBalance} symbol={currency} />,
    ]);
  }

  const cancelled = (r: StatementRow) => r.status === "cancelled";
  const cell = (content: ReactNode, muted: boolean): ReactNode =>
    muted ? (
      <span style={{ textDecoration: "line-through", color: "#b0b0b0" }}>{content}</span>
    ) : (
      content
    );
  const dash = "—";

  rows.forEach((r) => {
    const m = cancelled(r);
    const symbol = multi ? r.currencySymbol : currency;
    tableRows.push([
      cell(String(r.seq), m),
      cell(r.type === "opening" ? dash : r.date, m),
      cell(`${LEDGER_TYPE_LABEL[r.type] ?? r.type}${m ? " (ملغاة)" : ""}`, m),
      cell(r.referenceNumber ?? dash, m),
      cell(r.paymentNote ? `${r.description} — ${r.paymentNote}` : r.description, m),
      cell(r.originalAmount ? <span dir="ltr">{r.originalAmount}</span> : dash, m),
      cell(r.exchangeRate ? <span dir="ltr">{r.exchangeRate}</span> : dash, m),
      cell(r.quantityKg ? `${fmtQty(r.quantityKg)} كجم` : dash, m),
      cell(r.pricePerKg ? <Money amount={r.pricePerKg} /> : dash, m),
      cell(r.debit ? <Money amount={r.debit} /> : dash, m),
      cell(r.credit ? <Money amount={r.credit} /> : dash, m),
      cell(<Money amount={r.runningBalance} symbol={symbol} />, m),
    ]);
  });

  // One symbol per line, on the value; the label says what it is.
  const totalsList = totalsByCurrency
    ? totalsByCurrency.flatMap((t) => [
        { label: "إجمالي مدين", value: <Money amount={t.debit} symbol={t.symbol} />, grand: false },
        {
          label: "إجمالي دائن",
          value: <Money amount={t.credit} symbol={t.symbol} />,
          grand: false,
        },
        {
          label: "الرصيد النهائي",
          value: <Money amount={t.running} symbol={t.symbol} />,
          grand: true,
        },
      ])
    : [
        { label: "رصيد سابق", value: <Money amount={previousBalance} symbol={currency} /> },
        { label: "إجمالي مدين", value: <Money amount={totals.debit} symbol={currency} /> },
        { label: "إجمالي دائن", value: <Money amount={totals.credit} symbol={currency} /> },
        {
          label: "الرصيد النهائي",
          value: <Money amount={totals.running} symbol={currency} />,
          grand: true,
        },
      ];

  return (
    <PrintDocument
      title="كشف حساب"
      subtitle={partyName}
      meta={meta}
      totals={totalsList}
      signatures={["إعداد", "اعتماد"]}
      typeBadge="STATEMENT"
      orientation="landscape"
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
