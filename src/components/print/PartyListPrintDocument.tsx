import type { ReactNode } from "react";
import { PrintDocument, PrintTable, type PrintColumn } from "@/components/print/PrintDocument";
import type { PartyExportModel } from "@/components/parties/partyExportModel";
import { EXPORT_HEADERS } from "@/components/parties/partyExportModel";
import { currencySymbol } from "@/presentation/hooks/useCurrency";
import { Money } from "@/components/print/PrintMoney";

/**
 * Printed list of ALL customers or suppliers: one row per party, balances per currency.
 * Amounts are never blended across currencies: each currency's balance is its own cell, and the
 * summary block is one set of totals per currency.
 */
export function PartyListPrintDocument({
  model,
  title,
  dateLabel,
}: {
  model: PartyExportModel;
  title: string;
  dateLabel: string;
}) {
  const isSup = model.kind === "supplier";
  // Financial summary list: #, code, name, currency, and ONE balance per currency under
  // "لنا (مدين)" or "علينا (دائن)". Phone and a duplicate net column are intentionally omitted.
  // Fixed, balanced proportions (sum 100%). The table uses table-layout: fixed so these widths are
  // honoured; with auto layout the widest text column (the name) took most of the page.
  const columns: PrintColumn[] = [
    { key: "idx", label: "#", align: "center", nowrap: true, width: "5%" },
    { key: "code", label: "الرمز", align: "center", nowrap: true, width: "15%" },
    { key: "name", label: "الاسم", wrap: true, width: "25%" },
    { key: "ccy", label: "العملة", align: "center", nowrap: true, width: "10%" },
    { key: "rec", label: "لنا (مدين)", align: "left", amount: true, width: "22.5%" },
    { key: "pay", label: "علينا (دائن)", align: "left", amount: true, width: "22.5%" },
  ];

  // One currency label per row, always the Arabic symbol used across the app (ل.س / $ / €).
  // The amount cell carries only the number, so the symbol is never printed twice on one line.
  const rows: (string | ReactNode)[][] = [];
  for (const row of model.rows) {
    if (row.balances.length === 0) {
      rows.push([
        String(row.index),
        row.code || "—",
        row.name,
        currencyLabel("SYP"),
        <AmountCell key="r" amount={0} />,
        <AmountCell key="p" amount={0} />,
      ]);
      continue;
    }
    row.balances.forEach((b, i) => {
      rows.push([
        i === 0 ? String(row.index) : "",
        i === 0 ? row.code || "—" : "",
        i === 0 ? row.name : "",
        currencyLabel(b.currency),
        <AmountCell key="r" amount={b.receivable} />,
        <AmountCell key="p" amount={b.payable} />,
      ]);
    });
  }

  // One summary line per currency: receivable and payable (the net is not repeated as a column).
  const totals = model.summaryByCurrency.flatMap((s) => {
    const sym = currencySymbol(s.currency as "SYP" | "USD" | "EUR");
    return [
      {
        label: `إجمالي لنا (مدين) ${sym}`,
        value: <Money amount={s.receivable} />,
      },
      {
        label: `إجمالي علينا (دائن) ${sym}`,
        value: <Money amount={s.payable} />,
      },
    ];
  });

  return (
    <PrintDocument
      title={title}
      subtitle={`${model.partyCount} ${isSup ? "مورد" : "عميل"}`}
      meta={[
        { label: "التاريخ", value: dateLabel },
        { label: "عدد السجلات", value: String(model.partyCount) },
      ]}
      totals={totals.length > 0 ? totals : undefined}
      signatures={["إعداد", "اعتماد"]}
      orientation="landscape"
    >
      {rows.length === 0 ? (
        <div
          style={{ padding: "16pt 0 8pt", fontSize: "9.5pt", color: "#666", textAlign: "center" }}
        >
          لا توجد سجلات.
        </div>
      ) : (
        <PrintTable columns={columns} rows={rows} />
      )}
    </PrintDocument>
  );
}

/** The app's Arabic currency symbol for an ISO code (ل.س, $, €). Never the raw code. */
function currencyLabel(code: string): ReactNode {
  return currencySymbol(code as "SYP" | "USD" | "EUR");
}

/** A bare amount in a balance column, formatted with separators and two decimals. */
function AmountCell({ amount }: { amount: number }) {
  return <Money amount={amount} />;
}
