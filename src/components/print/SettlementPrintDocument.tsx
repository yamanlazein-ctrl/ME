import {
  PrintDocument,
  type PrintMetaItem,
  type PrintParty,
  type PrintTotal,
} from "@/components/print/PrintDocument";
import { currencySymbol } from "@/presentation/hooks/useCurrency";
import { formatMoney } from "@/shared/utils/formatNumber";
import type { SettleInvoicesResponse } from "@/contracts/statement";

const METHOD_LABEL: Record<string, string> = {
  cash: "نقدي",
  transfer: "تحويل",
  check: "شيك",
  card: "بطاقة",
};

export function SettlementPrintDocument({
  partyName,
  partyCode,
  partyKind,
  settlement,
}: {
  partyName: string;
  partyCode?: string | null;
  partyKind: "customer" | "supplier";
  settlement: SettleInvoicesResponse;
}) {
  const sym = currencySymbol(settlement.currency as "SYP" | "USD" | "EUR");
  const partyLabel = partyKind === "customer" ? "العميل" : "المورّد";

  const meta: PrintMetaItem[] = [
    { label: "رقم التسوية", value: settlement.batchNumber },
    { label: "التاريخ", value: settlement.date },
    { label: "عملة التسوية", value: `${settlement.currency} (${sym})` },
    { label: "طريقة الدفع", value: METHOD_LABEL[settlement.method] ?? settlement.method },
    ...(settlement.exchangeRate != null && settlement.exchangeRate > 0
      ? [{ label: "سعر صرف التسوية", value: formatMoney(settlement.exchangeRate) }]
      : []),
  ];

  const party: PrintParty = {
    label: partyLabel,
    name: partyName,
    ...(partyCode ? { extra: `رمز ${partyLabel}: ${partyCode}` } : {}),
  };

  const totals: PrintTotal[] = [
    {
      label: "إجمالي المستحق المحدد",
      value: `${formatMoney(settlement.totalDueInSettlement)} ${sym}`,
    },
    {
      label: "المبلغ المدفوع",
      value: `${formatMoney(settlement.amountPaid)} ${sym}`,
      grand: true,
    },
    {
      label: "الموزّع على الفواتير",
      value: `${formatMoney(settlement.totalAllocated)} ${sym}`,
    },
  ];

  return (
    <PrintDocument
      title="تسوية حساب"
      subtitle={partyKind === "customer" ? "سند قبض تسوية مجمّع" : "سند صرف تسوية مجمّع"}
      meta={meta}
      party={party}
      totals={totals}
    >
      <table className="print-table" style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
        <thead>
          <tr>
            <th style={{ textAlign: "right", padding: "4px 6px", borderBottom: "1px solid #ccc" }}>
              الفاتورة
            </th>
            <th style={{ textAlign: "right", padding: "4px 6px", borderBottom: "1px solid #ccc" }}>
              العملة
            </th>
            <th style={{ textAlign: "left", padding: "4px 6px", borderBottom: "1px solid #ccc" }}>
              المتبقي قبل
            </th>
            <th style={{ textAlign: "left", padding: "4px 6px", borderBottom: "1px solid #ccc" }}>
              المسدّد ({sym})
            </th>
            <th style={{ textAlign: "left", padding: "4px 6px", borderBottom: "1px solid #ccc" }}>
              بعملة الفاتورة
            </th>
            <th style={{ textAlign: "left", padding: "4px 6px", borderBottom: "1px solid #ccc" }}>
              المتبقي بعد
            </th>
            <th style={{ textAlign: "right", padding: "4px 6px", borderBottom: "1px solid #ccc" }}>
              السند
            </th>
          </tr>
        </thead>
        <tbody>
          {settlement.allocations.map((a) => (
            <tr key={a.invoiceId}>
              <td style={{ padding: "4px 6px" }}>{a.invoiceNumber}</td>
              <td style={{ padding: "4px 6px" }}>{a.invoiceCurrency}</td>
              <td style={{ padding: "4px 6px", textAlign: "left", fontVariantNumeric: "tabular-nums" }}>
                {formatMoney(a.remainingBefore)}
              </td>
              <td style={{ padding: "4px 6px", textAlign: "left", fontVariantNumeric: "tabular-nums" }}>
                {formatMoney(a.amountInSettlementCurrency)}
              </td>
              <td style={{ padding: "4px 6px", textAlign: "left", fontVariantNumeric: "tabular-nums" }}>
                {formatMoney(a.amountInInvoiceCurrency)} {currencySymbol(a.invoiceCurrency as "SYP" | "USD" | "EUR")}
              </td>
              <td style={{ padding: "4px 6px", textAlign: "left", fontVariantNumeric: "tabular-nums" }}>
                {formatMoney(a.remainingAfter)}
              </td>
              <td style={{ padding: "4px 6px" }}>{a.voucherNumber}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </PrintDocument>
  );
}
