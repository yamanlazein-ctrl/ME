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
 * Color cell: circular swatch + كود + name (same identity as inventory).
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
import { currencySymbol, formatAmount } from "@/presentation/hooks/useCurrency";
import { customerById } from "@/presentation/hooks/useParties";
import { useVouchersList } from "@/presentation/hooks/useVouchers";
import { useInvoiceVisibility } from "./visibility";
import { formatMoney, formatNumber, formatQuantity } from "@/shared/utils/formatNumber";
import { parseLineNote } from "@/components/print/noteParser";
import { fabricById, rollById, useInventory } from "@/presentation/hooks/useInventory";
import { PrintColorCell } from "./printColorCell";
import type { Invoice } from "@/domain/entities/Invoice";

type SaleInvoicePrintProps = {
  invoice: Invoice;
  totalPages?: number;
  pageNumber?: number;
  linesOverride?: Invoice["lines"];
};

// Use formatNumber for unit prices (preserves decimals), formatMoney for totals
const fmtUnit = (n: number): string => formatNumber(n);
const fmtMoney = (n: number): string => formatMoney(n);
const fmtQty = (n: number): string => formatQuantity(n);

export function SaleInvoicePrint({
  invoice,
  totalPages,
  pageNumber,
  linesOverride,
}: SaleInvoicePrintProps) {
  useInventory();
  const inv = invoice;
  const isFirstPage = pageNumber == null || pageNumber === 1;
  const isLastPage = pageNumber == null || totalPages == null || pageNumber === totalPages;
  const printLines = linesOverride ?? inv.lines;
  const vis = useInvoiceVisibility("sale");
  const customer = customerById(inv.partyId);
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
  const paid = inv.paid ?? 0;
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
  const statusLabel = isCancelled ? "ملغاة" : remaining > 0 ? "مفتوحة" : "مدفوعة";
  const meta: PrintMetaItem[] = [];
  if (vis.showInvoiceNumber)
    meta.push({ label: "رقم الفاتورة", value: inv.reference || inv.number });
  if (vis.showDate) meta.push({ label: "التاريخ", value: inv.date });
  if (vis.showStatus) meta.push({ label: "الحالة", value: statusLabel });
  if (vis.showCurrency) meta.push({ label: "العملة", value: `${inv.currency} (${sym})` });
  // L10: the hardcoded exchange-rate line was removed — it was cosmetic,
  // never used in any accounting computation, and misleading on invoices.
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
    { key: "color", label: "اللون", width: "22%" },
    { key: "roll", label: "رقم الصبغة", width: "12%" },
    { key: "pieces", label: "الأنواع", align: "center", width: "7%" },
    { key: "qty", label: "الكمية (كغ)", align: "center", width: "10%" },
    { key: "price", label: "السعر/كغ", align: "left", amount: true, width: "12%" },
    { key: "gross", label: "الإجمالي", align: "left", amount: true, width: "15%" },
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
  for (const l of printLines) {
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
  const totals: PrintTotal[] = [];
  if (vis.showSubtotal) {
    totals.push({ label: "المجموع", value: formatAmount(subtotal, inv.currency) });
  }
  if (vis.showDiscountTotal && discount > 0) {
    totals.push({ label: "الخصم", value: `− ${formatAmount(discount, inv.currency)}` });
  }
  if (vis.showTax && tax > 0) {
    totals.push({ label: "الضريبة", value: `+ ${formatAmount(tax, inv.currency)}` });
  }
  if (shipping > 0) {
    totals.push({ label: "الشحن", value: `+ ${formatAmount(shipping, inv.currency)}` });
  }
  if (vis.showGrandTotal) {
    totals.push({
      label: "الإجمالي النهائي",
      value: formatAmount(grand, inv.currency),
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
        ...(vis.showPartyCode && customer?.code ? { extra: `رمز العميل: ${customer.code}` } : {}),
      }
    : undefined;
  const payment = vis.showPaymentSummary
    ? [
        { label: "الإجمالي", value: formatAmount(grand, inv.currency) },
        { label: "المقبوض", value: formatAmount(paid, inv.currency) },
        { label: "الباقي", value: formatAmount(remaining, inv.currency) },
      ]
    : undefined;
  const pageSubtitle =
    !isFirstPage && totalPages && totalPages > 1
      ? `تابع — صفحة ${pageNumber} من ${totalPages}`
      : "بيع بضاعة للعميل";

  return (
    <PrintDocument
      title="فاتورة بيع"
      subtitle={pageSubtitle}
      meta={isFirstPage ? meta : undefined}
      party={isFirstPage ? party : undefined}
      totals={isLastPage ? totals : undefined}
      payment={isLastPage ? payment : undefined}
      notes={isLastPage && vis.showNotes ? inv.notes : undefined}
      signatures={isLastPage && vis.showSignatures ? ["توقيع المستلم", "ختم الشركة"] : undefined}
      pageNumber={pageNumber}
      totalPages={totalPages}
      typeBadge={vis.showTypeBadge ? "SALE" : undefined}
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
