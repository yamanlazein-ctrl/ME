/**
 * Entry Invoice (فاتورة شراء / فاتورة دخول) print template.
 *
 * Supplier-side document — records fabric received from a supplier
 * into a warehouse. Shows EVERY field on the Invoice entity:
 * - header meta (number, date, status, currency, created by, created at)
 * - party (supplier) block (name, phone, address, code)
 * - items table (fabric, category, color code+name, roll, qty, price, line discount, line note, line total)
 * - totals (subtotal, discount, tax, grand)
 * - payment summary (paid/remaining when vouchers exist)
 * - notes
 * - signatures
 * - footer
 *
 * Color cell: circular swatch + كود + name (same identity as inventory).
 * All fields are shown by default. Users can hide specific fields via
 * /settings/invoice — hiding affects the print only, never the data.
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
import { currencySymbol } from "@/presentation/hooks/useCurrency";
import { fabricById, rollById, useInventory } from "@/presentation/hooks/useInventory";
import { supplierById } from "@/presentation/hooks/useParties";
import { useVouchersList } from "@/presentation/hooks/useVouchers";
import { useInvoiceVisibility } from "./visibility";
import { formatMoney, formatNumber, formatQuantity } from "@/shared/utils/formatNumber";
import { parseLineNote } from "@/components/print/noteParser";
import { PrintColorCell } from "./printColorCell";
import type { Invoice } from "@/domain/entities/Invoice";

type EntryInvoicePrintProps = {
  invoice: Invoice;
  totalPages?: number;
  pageNumber?: number;
};

// Use formatNumber for unit prices (preserves decimals), formatMoney for totals
const fmtUnit = (n: number): string => formatNumber(n);
const fmtMoney = (n: number): string => formatMoney(n);
const fmtQty = (n: number): string => formatQuantity(n);

export function EntryInvoicePrint({ invoice, totalPages, pageNumber }: EntryInvoicePrintProps) {
  // Ensure inventory cache is subscribed so colour lookups stay reactive.
  useInventory();
  const inv = invoice;
  const vis = useInvoiceVisibility("purchase");
  const supplier = supplierById(inv.partyId);
  // Pull vouchers so we can show paid/remaining — same data the detail
  // page uses (invoices.$id.tsx). Linked receipts/payments to this
  // invoice appear here.
  const { data: vouchersData } = useVouchersList();
  const allVouchers = useMemo(
    () =>
      (vouchersData?.data ?? []) as Array<{
        invoiceId: string;
        status: string;
        amount: number;
        number: string;
        date: string;
        method: string;
      }>,
    [vouchersData],
  );
  const linkedVouchers = useMemo(
    () => allVouchers.filter((v) => v.invoiceId === inv.id && v.status === "active"),
    [allVouchers, inv.id],
  );
  // Read paid from the invoice row (backend-maintained, FX-converted) —
  // never sum voucher amounts raw across currencies.
  const paidAmount = inv.paid ?? 0;
  const paymentMethod = linkedVouchers[0]?.method;
  const subtotal = inv.lineSubtotal();
  const discount = inv.discount ?? 0;
  const tax = inv.tax ?? 0;
  const shipping = inv.shipping ?? 0;
  // Grand total = subtotal - discount + tax + shipping
  const grand = inv.total();
  const remaining = Math.max(0, grand - paidAmount);
  const sym = currencySymbol(inv.currency);
  const isCancelled = inv.status === "cancelled";
  const statusLabel = isCancelled
    ? "ملغاة"
    : remaining > 0
      ? `مفتوحة (المتبقي ${fmtMoney(remaining)} ${sym})`
      : "مقفلة (مدفوعة)";
  // ── Meta grid (only fields the user has not hidden) ──────────────
  const meta: PrintMetaItem[] = [];
  if (vis.showInvoiceNumber)
    meta.push({ label: "رقم الفاتورة", value: inv.reference || inv.number });
  if (vis.showDate) meta.push({ label: "التاريخ", value: inv.date });
  if (vis.showStatus) meta.push({ label: "الحالة", value: statusLabel });
  if (vis.showCurrency) meta.push({ label: "العملة", value: `${inv.currency} (${sym})` });
  if (vis.showCreatedBy) meta.push({ label: "أنشأ بواسطة", value: inv.createdBy ? String(inv.createdBy) : "" });
  if (vis.showCancelledInfo && isCancelled && inv.cancelledAt) {
    meta.push({
      label: "تاريخ الإلغاء",
      value: String(inv.cancelledAt).slice(0, 19).replace("T", " "),
    });
  }
  // ── Items table — rolls + pieces in the MAIN row (Issue 13), not nested.
  const mainColumns: PrintColumn[] = [
    { key: "fabric", label: "الصنف", width: "22%" },
    { key: "color", label: "اللون", width: "14%" },
    { key: "roll", label: "رقم الصبغة", width: "14%" },
    { key: "pieces", label: "الأثواب", align: "center", width: "8%" },
    { key: "qty", label: "الكمية (كغ)", align: "center", width: "12%" },
    { key: "price", label: "السعر/كغ", align: "left", amount: true, width: "12%" },
    { key: "gross", label: "الإجمالي", align: "left", amount: true, width: "18%" },
  ];

  /** Build a row: main cells + optional secondary detail (machine/kromaj only). */
  function buildRow(l: Invoice["lines"][number]) {
    const fab = fabricById(l.fabricId);
    const roll = rollById(l.rollId);
    const parsed = parseLineNote(l.note);
    const lineTotal = inv.lineTotal(l);
    const rollLabel = roll?.rollNo
      ? `#${roll.rollNo}`
      : roll?.dyeBatch
        ? String(roll.dyeBatch)
        : "—";

    const main: Record<string, string | number | React.ReactNode> = {
      fabric: fab?.name ?? "—",
      color: <PrintColorCell colorId={l.colorId} />,
      roll: rollLabel,
      pieces: l.pieces && l.pieces >= 1 ? String(l.pieces) : "—",
      qty: fmtQty(l.quantityKg),
      price: fmtUnit(l.pricePerKg),
      gross: fmtMoney(lineTotal),
    };

    const details: Array<{ label: string; value: string }> = [];
    if (parsed.machineNo) details.push({ label: "رقم الماكينة", value: parsed.machineNo });
    if (parsed.chromaj) details.push({ label: "الكراماج", value: parsed.chromaj });
    else if (roll?.weightGsm) details.push({ label: "الكراماج", value: String(roll.weightGsm) });
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
      // Render as a mini-grid: 4 label:value cells per row
      const gridCols = 4;
      const detailGrid = (
        <div key="detail" className="pd-detail-grid">
          {r.details.map((d, i) => (
            <div key={i} className="pd-detail-item">
              <span className="pd-detail-label">{d.label}</span>
              <span className="pd-detail-val">{d.value}</span>
            </div>
          ))}
          {/* Fill empty cells if less than gridCols */}
          {Array.from({ length: gridCols - (r.details.length % gridCols || gridCols) }).map(
            (_, i) => (
              <div key={`empty-${i}`} className="pd-detail-item pd-detail-empty" />
            ),
          )}
        </div>
      );
      rows.push([detailGrid as React.ReactNode]);
    }
  }
  // ── Totals (only show ones with value > 0 OR if the user wants to
  //    see the row regardless of value — for now we show them only
  //    when there is data, but the user can override via settings).
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
  // ── Party block (supplier) — every field the user wants.
  const party: PrintParty | undefined = vis.showPartyName
    ? {
        label: "المورّد",
        name: supplier?.name ?? "مورّد غير معرّف",
        ...(vis.showPartyPhone && supplier?.phone ? { phone: supplier.phone } : {}),
        ...(vis.showPartyAddress && (supplier?.address || supplier?.city)
          ? { address: [supplier.address, supplier.city].filter(Boolean).join(" — ") }
          : {}),
        ...(vis.showPartyCode && supplier?.code ? { extra: `رمز المورّد: ${supplier.code}` } : {}),
      }
    : undefined;
  // ── Payment summary (paid / remaining) — entry invoices can have
  //    linked payment vouchers too, so we show them.
  const payment = vis.showPaymentSummary
    ? [
        { label: "الإجمالي", value: `${fmtMoney(grand)} ${sym}` },
        { label: "المدفوع", value: `${fmtMoney(paidAmount)} ${sym}` },
        { label: "المتبقي", value: `${fmtMoney(remaining)} ${sym}` },
      ]
    : undefined;
  return (
    <PrintDocument
      title="فاتورة شراء"
      subtitle="إدخال بضاعة إلى المخزون"
      meta={meta}
      party={party}
      totals={totals}
      payment={payment}
      notes={vis.showNotes ? inv.notes : undefined}
      signatures={vis.showSignatures ? ["توقيع المستلم", "ختم الشركة"] : undefined}
      pageNumber={pageNumber}
      totalPages={totalPages}
      typeBadge={vis.showTypeBadge ? "PURCHASE" : undefined}
      hideFooter={!vis.showFooter}
      extraMeta={[
        // QA fix (Part 2): show the frozen FX rate on printed paper when the
        // document currency is NOT the base currency (USD) and a real rate
        // (> 1) was captured at creation time.
        ...(inv.currency !== "USD" && Number(inv.exchangeRate) > 1
          ? [
              {
                label: "سعر الصرف",
                value: `${formatNumber(Number(inv.exchangeRate))} (بتاريخ ${inv.date})`,
              },
              {
                label: "المعادل بالدولار",
                value: `$${formatNumber(Number(inv.baseTotal) || 0)}`,
              },
            ]
          : []),
        ...(vis.showPaymentMethod && paymentMethod
          ? [{ label: "طريقة الدفع", value: String(paymentMethod) }]
          : []),
      ]}
    >
      <PrintTable columns={columns} rows={rows} />
    </PrintDocument>
  );
}
