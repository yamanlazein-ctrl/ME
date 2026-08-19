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
import { customerById } from "@/presentation/hooks/useParties";
import { useVouchersList } from "@/presentation/hooks/useVouchers";
import { useInvoiceVisibility } from "./visibility";
import { resolveCreatedBy } from "@/presentation/hooks/useSettings";
import { formatMoney, formatNumber, formatQuantity } from "@/shared/utils/formatNumber";
import { parseLineNote } from "@/components/print/noteParser";
import {
  fabricById,
  colorById,
  rollById,
  type Color,
} from "@/presentation/hooks/useInventory";
import type { Invoice, InvoiceLineData } from "@/domain/entities/Invoice";

/** Render a color cell showing code, name, and hex swatch — same pattern as EntryInvoicePrint. */
function renderColorCell(colorId: string) {
  const col = colorById(colorId) as Pick<Color, "code" | "name" | "hex"> | null;
  if (!col) return "—";
  const hexSwatch = col.hex
    ? {
        display: "inline-block",
        width: "10px",
        height: "10px",
        borderRadius: "2px",
        backgroundColor: col.hex,
        border: "1px solid rgba(0,0,0,0.15)",
        marginRight: "4px",
        verticalAlign: "middle" as const,
      }
    : null;
  return (
    <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.25 }}>
      <span style={{ display: "flex", alignItems: "center", gap: "4px" }}>
        {hexSwatch && <span style={hexSwatch} />}
        {col.code && <span className="pd-color-code">{col.code}</span>}
      </span>
      {col.name && <span className="pd-color-name">{col.name}</span>}
    </div>
  );
}

type SaleInvoicePrintProps = {
  invoice: Invoice;
  totalPages?: number;
  pageNumber?: number;
};

// Use formatNumber for unit prices (preserves decimals), formatMoney for totals
const fmtUnit = (n: number): string => formatNumber(n);
const fmtMoney = (n: number): string => formatMoney(n);
const fmtQty = (n: number): string => formatQuantity(n);

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
  const paidFromVouchers = linkedVouchers.reduce((s, v) => s + v.amount, 0);
  // Use explicit paid field if provided (manual payment at invoice time), otherwise derive from vouchers
  const paid = inv.paid !== undefined && inv.paid > 0 ? inv.paid : paidFromVouchers;
  const paymentMethod = linkedVouchers[0]?.method;
  const subtotal = inv.lineSubtotal();
  const discount = inv.discount ?? 0;
  const tax = inv.tax ?? 0;
  const shipping = inv.shipping ?? 0;
  // Grand total = subtotal - discount + tax + shipping
  const grand = inv.total();
  const remaining = Math.max(0, grand - paid);
  const sym = currencySymbol(inv.currency);
  const isCancelled = inv.status === "cancelled";
  const statusLabel = isCancelled
    ? "ملغاة"
    : remaining > 0
      ? `مفتوحة (المتبقي ${fmtMoney(remaining)} ${sym})`
      : "مقفلة (مدفوعة)";
  const meta: PrintMetaItem[] = [];
  if (vis.showInvoiceNumber) meta.push({ label: "رقم الفاتورة", value: inv.reference || inv.number });
  if (vis.showDate) meta.push({ label: "التاريخ", value: inv.date });
  if (vis.showStatus) meta.push({ label: "الحالة", value: statusLabel });
  if (vis.showCurrency) meta.push({ label: "العملة", value: `${inv.currency} (${sym})` });
  meta.push({
    label: "سعر الصرف",
    value: `1 $ = ${fmtUnit(currencyState.rates.USD)} ل.س — ${currencyState.lastUpdated}`,
  });
  if (vis.showCreatedBy) meta.push({ label: "أنشأ بواسطة", value: resolveCreatedBy(inv.createdBy) });
  if (vis.showCancelledInfo && isCancelled && inv.cancelledAt) {
    meta.push({
      label: "تاريخ الإلغاء",
      value: String(inv.cancelledAt).slice(0, 19).replace("T", " "),
    });
  }
  // ── Items table — 5 main columns only. Extra details (roll no,
  //    pieces, machine, kromaj, count, draw, reference) rendered
  //    below each row as a compact detail line.
  const mainColumns: PrintColumn[] = [
    { key: "fabric", label: "الصنف", width: "28%" },
    { key: "color", label: "اللون", width: "18%" },
    { key: "qty", label: "الكمية (كغ)", align: "center", width: "16%" },
    { key: "price", label: "السعر/كغ", align: "left", amount: true, width: "16%" },
    { key: "gross", label: "الإجمالي", align: "left", amount: true, width: "22%" },
  ];

  /** Build a row: main cells + optional detail block below. */
  function buildRow(l: Invoice["lines"][number]) {
    const fab = fabricById(l.fabricId);
    const roll = rollById(l.rollId);
    const parsed = parseLineNote(l.note);
    const sub = l.quantityKg * l.pricePerKg;
    const lineTotal = Math.max(0, sub - (l.discountAmount || 0));

    const main: Record<string, string | number | React.ReactNode> = {
      fabric: fab?.name ?? "—",
      color: renderColorCell(l.colorId),
      qty: fmtQty(l.quantityKg),
      price: fmtUnit(l.pricePerKg),
      gross: fmtMoney(lineTotal),
    };

    // Extra details that go below the main row
    const details: Array<{ label: string; value: string }> = [];
    if (roll?.dyeBatch) details.push({ label: "رقم الصبغة", value: roll.dyeBatch });
    else if (roll?.rollNo) details.push({ label: "رقم الصبغة", value: roll.rollNo });
    if (l.pieces && l.pieces > 1) details.push({ label: "الأثواب", value: String(l.pieces) });
    if (parsed.machineNo) details.push({ label: "رقم الماكينة", value: parsed.machineNo });
    if (parsed.chromaj) details.push({ label: "الكراماج", value: parsed.chromaj });
    else if (roll?.weightGsm) details.push({ label: "الكراماج", value: String(roll.weightGsm) });
    if (parsed.count) details.push({ label: "العدد", value: parsed.count });
    if (parsed.draw) details.push({ label: "السحب", value: parsed.draw });
    if (parsed.reference) details.push({ label: "المرجعية", value: parsed.reference });

    return { main, details };
  }

  const columns = mainColumns;
  const rows: (string | number | React.ReactNode)[][] = [];
  for (const l of inv.lines) {
    const r = buildRow(l);
    rows.push(columns.map((c) => r.main[c.key] ?? "—"));
    if (r.details.length > 0) {
      const gridCols = 4;
      const detailGrid = (
        <div key="detail" className="pd-detail-grid">
          {r.details.map((d, i) => (
            <div key={i} className="pd-detail-item">
              <span className="pd-detail-label">{d.label}</span>
              <span className="pd-detail-val">{d.value}</span>
            </div>
          ))}
          {Array.from({ length: gridCols - (r.details.length % gridCols || gridCols) }).map((_, i) => (
            <div key={`empty-${i}`} className="pd-detail-item pd-detail-empty" />
          ))}
        </div>
      );
      rows.push([detailGrid as React.ReactNode]);
    }
  }
  const totals: PrintTotal[] = [];
  if (vis.showSubtotal) {
    totals.push({ label: "المجموع", value: `${fmtMoney(subtotal)} ${sym}` });
  }
  if (vis.showDiscountTotal && discount > 0) {
    totals.push({ label: "الخصم", value: `- ${fmtMoney(discount)} ${sym}` });
  }
  if (vis.showTax && tax > 0) {
    totals.push({ label: "الضريبة", value: `+ ${fmtMoney(tax)} ${sym}` });
  }
  if (shipping > 0) {
    totals.push({ label: "الشحن", value: `+ ${fmtMoney(shipping)} ${sym}` });
  }
  if (vis.showGrandTotal) {
    totals.push({
      label: "الإجمالي النهائي",
      value: `${fmtMoney(grand)} ${sym}`,
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
        { label: "الإجمالي", value: `${fmtMoney(grand)} ${sym}` },
        { label: "المقبوض", value: `${fmtMoney(paid)} ${sym}` },
        { label: "الباقي", value: `${fmtMoney(remaining)} ${sym}` },
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
    </PrintDocument>
  );
}
