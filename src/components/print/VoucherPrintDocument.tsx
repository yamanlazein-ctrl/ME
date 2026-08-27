import type { Voucher } from "@/domain/entities/Voucher";
import {
  PrintDocument,
  type PrintMetaItem,
  type PrintParty,
  type PrintTotal,
} from "@/components/print/PrintDocument";
import { currencySymbol } from "@/presentation/hooks/useCurrency";
import { customerById, supplierById } from "@/presentation/hooks/useParties";
import { formatMoney } from "@/shared/utils/formatNumber";

const METHOD_LABEL: Record<string, string> = {
  cash: "نقدي",
  transfer: "تحويل",
  check: "شيك",
  card: "بطاقة",
};

/**
 * Receipt / Payment voucher print template.
 *
 * Reuses the SAME unified PrintDocument header/footer as invoices so the
 * company name, logo, divider, and footer come from one shared component —
 * never a per-document copy-paste.
 */
export function VoucherPrintDocument({ voucher }: { voucher: Voucher }) {
  const v = voucher;
  const isReceipt = v.kind === "receipt";
  const sym = currencySymbol(v.currency);
  const party = isReceipt ? customerById(v.partyId) : supplierById(v.partyId);
  const partyLabel = isReceipt ? "العميل" : "المورّد";
  const title = isReceipt ? "سند قبض" : "سند صرف";
  const subtitle = isReceipt ? "مبلغ مستلم من العميل" : "مبلغ مدفوع للمورّد";

  const meta: PrintMetaItem[] = [
    { label: "رقم السند", value: v.number },
    { label: "التاريخ", value: v.date },
    { label: "العملة", value: `${v.currency} (${sym})` },
    { label: "طريقة الدفع", value: METHOD_LABEL[v.method] ?? v.method },
    { label: "الحالة", value: v.status === "active" ? "نشط" : "ملغى" },
  ];

  const partyBlock: PrintParty | undefined = party
    ? {
        label: partyLabel,
        name: party.name,
        ...(party.code ? { extra: `رمز ${partyLabel}: ${party.code}` } : {}),
      }
    : { label: partyLabel, name: "—" };

  const totals: PrintTotal[] = [
    { label: "المبلغ", value: `${formatMoney(v.amount)} ${sym}`, grand: true },
  ];

  return (
    <PrintDocument
      title={title}
      subtitle={subtitle}
      meta={meta}
      party={partyBlock}
      totals={totals}
      notes={v.notesPrint ?? undefined}
      signatures={["توقيع المستلم", "ختم الشركة"]}
      typeBadge={isReceipt ? "RECEIPT" : "PAYMENT"}
    >
      <div
        style={{
          textAlign: "center",
          padding: "20px 0",
          fontSize: "13px",
          color: "#444",
        }}
      >
        {v.invoiceId ? "سند مرتبط بفاتورة" : "دفعة عامة"}
      </div>
    </PrintDocument>
  );
}