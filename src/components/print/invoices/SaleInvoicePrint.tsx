/**
 * Sale Invoice (فاتورة بيع) print template.
 *
 * Customer-side document — records fabric sold to a customer.
 * Shows EVERY field on the Invoice entity:
 * - header meta (number, date, status, currency, created by/at)
 * - party (customer) block (name, phone, address, code)
 * - items table (fabric, color code+name, roll, qty, price, line discount, line note, line total)
 * - totals (subtotal, discount, tax, grand)
 * - payment summary (paid / remaining / method)
 * - notes
 * - signatures
 * - footer
 *
 * No color swatches — color is shown as `code` + `name` text only.
 * All fields default to visible. Users can hide via /settings/invoice.
 */
import { useMemo, type ReactNode } from "react";
import {
  PrintDocument,
  PrintTable,
  type PrintColumn,
  type PrintMetaItem,
  type PrintTotal,
  type PrintParty,
} from "@/components/print/PrintDocument";
import { currencySymbol, currencyState, useCurrencies } from "@/presentation/hooks/useCurrency";
import {
  colorById,
  fabricById,
  rollById,
  type Color,
} from "@/presentation/hooks/useInventory";
import { customerById } from "@/presentation/hooks/useParties";
import { useVouchersList } from "@/presentation/hooks/useVouchers";
import { useInvoiceVisibility } from "./visibility";
import { formatMoney, formatQuantity } from "@/shared/utils/formatNumber";
import type { Invoice, InvoiceLineData } from "@/domain/entities/Invoice";
import { parseLineDetails } from "./lineDetails";

const DETAILS_TITLE = String.fromCharCode(0x62a, 0x641, 0x627, 0x635, 0x64a, 0x644, 0x20, 0x625, 0x636, 0x627, 0x641, 0x64a, 0x629);
const BAND_LABEL = String.fromCharCode(0x628, 0x646, 0x62f);

type SaleInvoicePrintProps = {
  invoice: Invoice;
  totalPages?: number;
  pageNumber?: number;
};

const fmtNumber = (n: number): string => formatMoney(n);
const fmtQty = (n: number): string => formatQuantity(n);

function renderColorCell(line: InvoiceLineData) {
  const col = colorById(line.colorId) as Pick<Color, "code" | "name"> | null;
  if (!col) return "—";
  return (
    <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.25 }}>
      {col.code && <span className="pd-color-code">{col.code}</span>}
      <span className="pd-color-name">{col.name}</span>
    </div>
  );
}
export function SaleInvoicePrint({
  invoice,
  totalPages,
  pageNumber,
}: SaleInvoicePrintProps) {
  const inv = invoice;
  useCurrencies();
  const vis = useInvoiceVisibility("sale");
  const customer = customerById(inv.partyId);
  const { data: vouchersData } = useVouchersList();
  const allVouchers = useMemo(
    () => (vouchersData?.data ?? []) as Array<{ invoiceId: string; status: string; amount: number; number: string; date: string; method: string }>,
    [vouchersData],
  );
  const linkedVouchers = useMemo(
    () => allVouchers.filter((v) => v.invoiceId === inv.id && v.status === "active"),
    [allVouchers, inv.id],
  );
  const paid = linkedVouchers.reduce((s, v) => s + v.amount, 0);
  const paymentMethod = linkedVouchers[0]?.method;
  const subtotal = inv.total();
  const discount = inv.discount ?? 0;
  const tax = inv.tax ?? 0;
  const grand = subtotal - discount + tax;
  const remaining = Math.max(0, grand - paid);
  const sym = currencySymbol(inv.currency);
  const isCancelled = inv.status === "cancelled";
  const statusLabel = isCancelled
    ? "ملغاة"
    : inv.status === "draft"
      ? "مسودة"
      : remaining > 0
        ? "مفتوحة (متبقي)"
        : "مدفوعة بالكامل";
  const meta: PrintMetaItem[] = [];
  if (vis.showInvoiceNumber) meta.push({ label: "رقم الفاتورة", value: inv.number });
  if (vis.showDate) meta.push({ label: "التاريخ", value: inv.date });
  if (vis.showStatus) meta.push({ label: "الحالة", value: statusLabel });
  if (vis.showCurrency) meta.push({ label: "العملة", value: `${inv.currency} (${sym})` });
  meta.push({
    label: "سعر الصرف",
    value: `1 $ = ${fmtNumber(currencyState.rates.USD)} ل.س — ${currencyState.lastUpdated}`,
  });
  if (vis.showCreatedBy && inv.createdBy) meta.push({ label: "أنشأ بواسطة", value: inv.createdBy });
  if (vis.showCreatedAt && inv.createdAt) {
    meta.push({
      label: "تاريخ الإنشاء",
      value: String(inv.createdAt).slice(0, 19).replace("T", " "),
    });
  }
  if (vis.showCancelledInfo && isCancelled && inv.cancelledAt) {
    meta.push({
      label: "تاريخ الإلغاء",
      value: String(inv.cancelledAt).slice(0, 19).replace("T", " "),
    });
  }
  const allColumns: { key: string; cfg: PrintColumn; on?: boolean }[] = [
    { key: "idx", cfg: { key: "idx", label: "#", align: "center", width: "4%" }, on: vis.showLineIndex },
    { key: "fabric", cfg: { key: "fabric", label: "القماش", width: "18%" }, on: vis.showFabric },
    { key: "category", cfg: { key: "category", label: "الفئة", width: "10%" }, on: vis.showFabricCategory },
    { key: "color", cfg: { key: "color", label: "اللون", width: "16%" }, on: vis.showColorCode || vis.showColorName },
    { key: "roll", cfg: { key: "roll", label: "رقم الصبغة", width: "13%" }, on: vis.showRollNumber },
    { key: "qty", cfg: { key: "qty", label: "الكمية (كغ)", align: "center", width: "9%" }, on: vis.showQuantity },
    { key: "price", cfg: { key: "price", label: "السعر/كغ", align: "left", amount: true, width: "9%" }, on: vis.showUnitPrice },
    { key: "discount", cfg: { key: "discount", label: "الخصم", align: "center", width: "7%" }, on: vis.showLineDiscount },
    { key: "gross", cfg: { key: "gross", label: "الإجمالي", align: "left", amount: true, width: "10%" }, on: vis.showLineTotal },
  ];
  const columns = allColumns.filter((c) => c.on !== false).map((c) => c.cfg);
  const rows = inv.lines.map((l, i) => {
    const fab = fabricById(l.fabricId);
    const roll = rollById(l.rollId);
    const sub = l.quantityKg * l.pricePerKg;
    const lineTotal = Math.max(0, sub - (l.discountAmount || 0));
    const cell: Record<string, string | number | React.ReactNode> = {
      idx: i + 1,
      fabric: fab?.name ?? "—",
      category: fab?.category ?? "—",
      color: renderColorCell(l),
      roll: roll ? roll.rollNo : "—",
      qty: fmtNumber(l.quantityKg),
      price: fmtNumber(l.pricePerKg),
      discount: (l.discountAmount || 0) > 0 ? fmtNumber(l.discountAmount) : "—",
      gross: fmtNumber(lineTotal),
    };
    return columns.map((c) => cell[c.key] ?? "—");
  });
  const totals: PrintTotal[] = [];
  if (vis.showSubtotal) {
    totals.push({ label: "المجموع", value: `${fmtNumber(subtotal)} ${sym}` });
  }
  if (vis.showDiscountTotal && discount > 0) {
    totals.push({ label: "الخصم", value: `- ${fmtNumber(discount)} ${sym}` });
  }
  if (vis.showTax && tax > 0) {
    totals.push({ label: "الضريبة", value: `+ ${fmtNumber(tax)} ${sym}` });
  }
  if (vis.showGrandTotal) {
    totals.push({
      label: "الإجمالي النهائي",
      value: `${fmtNumber(grand)} ${sym}`,
      grand: true,
    });
  }
  const party: PrintParty | undefined = vis.showPartyName
    ? {
        label: "العميل",
        name: customer?.name ?? "عميل غير معرّف",
        ...(vis.showPartyPhone && customer?.phone ? { phone: customer.phone } : {}),
        ...(vis.showPartyAddress && (customer?.address || customer?.city)
          ? { address: [customer.address, customer.city].filter(Boolean).join(" — ") }
          : {}),
        ...(vis.showPartyCode && customer?.code
          ? { extra: `رمز العميل: ${customer.code}` }
          : {}),
      }
    : undefined;
  const payment = vis.showPaymentSummary
    ? [
        { label: "الإجمالي", value: `${fmtNumber(grand)} ${sym}` },
        { label: "المقبوض", value: `${fmtNumber(paid)} ${sym}` },
        { label: "الباقي", value: `${fmtNumber(remaining)} ${sym}` },
      ]
    : undefined;
  return (
    <PrintDocument
      title="فاتورة بيع"
      subtitle="بيع بضاعة للعميل"
      meta={meta}
      party={party}
      totals={totals}
      payment={payment}
      notes={vis.showNotes ? inv.notes : undefined}
      signatures={vis.showSignatures ? ["توقيع المستلم", "ختم الشركة"] : undefined}
      pageNumber={pageNumber}
      totalPages={totalPages}
      typeBadge={vis.showTypeBadge ? "SALE" : undefined}
      hideFooter={!vis.showFooter}
      extraMeta={
        vis.showPaymentMethod && paymentMethod
          ? [{ label: "طريقة الدفع", value: String(paymentMethod) }]
          : undefined
      }
    >
      <PrintTable columns={columns} rows={rows} />
      {inv.lines.map((l, i) => {
        const parsed = parseLineDetails(l.note);
        if (parsed.details.length === 0 && !parsed.freeText) return null;
        return (
          <div key={l.id} className="print-line-details">
            <div className="print-line-details-title">{DETAILS_TITLE} - {BAND_LABEL} {i + 1}</div>
            <div className="print-line-details-grid">
              {parsed.details.map((d) => (
                <div key={d.label} className="print-line-detail-item">
                  <span className="print-line-detail-label">{d.label}</span>
                  <span className="print-line-detail-value">{d.value}</span>
                </div>
              ))}
            </div>
            {parsed.freeText && (
              <div className="print-line-free-note">{parsed.freeText}</div>
            )}
          </div>
        );
      })}
    </PrintDocument>
  );
}
