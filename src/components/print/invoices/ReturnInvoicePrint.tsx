/**
 * Return Invoice (مرتجع) print template.
 *
 * Supports both kinds: "entry" (return to supplier) and "sale"
 * (return from customer). Header title, badge, and party block
 * adapt to the kind. Original invoice reference and reason are
 * shown — the audit trail needs to know why goods left the warehouse.
 *
 * Shows EVERY field on the Return DTO:
 * - header meta (number, date, status, currency, created by/at, reason, original invoice)
 * - party (supplier or customer) block (name, phone, address, code)
 * - items table (roll, fabric, color code+name, qty, price, line total)
 * - totals (grand)
 * - notes (notesPrint)
 * - signatures
 * - footer
 *
 * No color swatches — color shown as `code` + `name` text only.
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
import { colorById, fabricById, rollById, type Color } from "@/presentation/hooks/useInventory";
import { formatMoney, formatNumber, formatQuantity } from "@/shared/utils/formatNumber";
import type { ReturnDTO, ReturnReason } from "@/application/ports/IReturnRepository";
import { customerById, supplierById } from "@/presentation/hooks/useParties";
import { useInvoiceVisibility } from "./visibility";
import { useVouchersList } from "@/presentation/hooks/useVouchers";
import { resolveCreatedBy } from "@/presentation/hooks/useSettings";

type ReturnInvoicePrintProps = {
  returnDoc: ReturnDTO;
  /** Map of original invoice numbers by id, so the document can show
   *  the source invoice number without extra lookups. */
  originalInvoiceNumber?: string;
  totalPages?: number;
  pageNumber?: number;
};

const REASON_LABEL: Record<ReturnReason, string> = {
  defect: "عيب في القماش",
  wrong_quantity: "خطأ بالكمية",
  wrong_order: "خطأ بالطلب",
  other: "أخرى",
};

const KIND_TITLE: Record<ReturnDTO["kind"], string> = {
  entry: "مرتجع شراء (للمورّد)",
  sale: "مرتجع بيع (من العميل)",
};

const KIND_SUBTITLE: Record<ReturnDTO["kind"], string> = {
  entry: "إرجاع بضاعة إلى المورّد",
  sale: "استلام بضاعة مرتجعة من العميل",
};

const KIND_BADGE: Record<ReturnDTO["kind"], "RETURN_IN" | "RETURN_OUT"> = {
  entry: "RETURN_IN",
  sale: "RETURN_OUT",
};

// Use formatNumber for unit prices (preserves decimals), formatMoney for totals
const fmtUnit = (n: number): string => formatNumber(n);
const fmtMoney = (n: number): string => formatMoney(n);
const fmtQty = (n: number): string => formatQuantity(n);

function renderRollColorCell(rollId: string) {
  const roll = rollById(rollId);
  if (!roll) return "—";
  const col = colorById(roll.colorId) as Pick<Color, "code" | "name"> | null;
  if (!col) return "—";
  return (
    <div style={{ display: "flex", flexDirection: "column", lineHeight: 1.25 }}>
      {col.code && <span className="pd-color-code">{col.code}</span>}
      <span className="pd-color-name">{col.name}</span>
    </div>
  );
}
export function ReturnInvoicePrint({
  returnDoc,
  originalInvoiceNumber,
  totalPages,
  pageNumber,
}: ReturnInvoicePrintProps) {
  const r = returnDoc;
  useCurrencies();
  const vis = useInvoiceVisibility(r.kind === "entry" ? "return_in" : "return_out");
  const isSupplierReturn = r.kind === "entry";
  const party = isSupplierReturn ? supplierById(r.partyId) : customerById(r.partyId);
  const sym = currencySymbol(r.currency as "SYP" | "USD" | "EUR");
  // Pull vouchers to show payment method when linked
  const { data: vouchersData } = useVouchersList();
  const allVouchers = useMemo(
    () => (vouchersData?.data ?? []) as Array<{ status: string; method: string; partyId: string }>,
    [vouchersData],
  );
  const linkedVouchers = useMemo(
    () => allVouchers.filter((v) => v.partyId === r.partyId && v.status === "active"),
    [allVouchers, r.partyId],
  );
  const paymentMethod = linkedVouchers[0]?.method;
  const total = r.lines.reduce((s, l) => s + l.quantityKg * l.pricePerKg, 0);
  const isCancelled = r.status === "cancelled";
  const statusLabel = isCancelled ? "ملغى" : "نشط";
  // ── Meta grid (visibility-aware) ──
  const meta: PrintMetaItem[] = [];
  if (vis.showInvoiceNumber) meta.push({ label: "رقم المرتجع", value: r.reference || r.number });
  if (vis.showDate) meta.push({ label: "التاريخ", value: r.date });
  if (vis.showStatus) meta.push({ label: "الحالة", value: statusLabel });
  if (vis.showCurrency) meta.push({ label: "العملة", value: `${r.currency} (${sym})` });
  meta.push({
    label: "سعر الصرف",
    value: `1 $ = ${fmtUnit(currencyState.rates.USD)} ل.س — ${currencyState.lastUpdated}`,
  });
  if (vis.showCreatedBy) meta.push({ label: "أنشأ بواسطة", value: resolveCreatedBy(r.createdBy) });
  if (vis.showCreatedAt && r.createdAt) {
    meta.push({
      label: "تاريخ الإنشاء",
      value: String(r.createdAt).slice(0, 19).replace("T", " "),
    });
  }
  if (vis.showCancelledInfo && isCancelled && r.cancelledAt) {
    meta.push({
      label: "تاريخ الإلغاء",
      value: String(r.cancelledAt).slice(0, 19).replace("T", " "),
    });
  }
  if (vis.showReason) {
    meta.push({ label: "السبب", value: REASON_LABEL[r.reason] ?? r.reason });
  }
  if (vis.showOriginalInvoice && r.originalInvoiceId) {
    meta.push({
      label: isSupplierReturn ? "فاتورة الشراء الأصلية" : "فاتورة البيع الأصلية",
      value: originalInvoiceNumber ?? r.originalInvoiceId,
    });
  }
  // ── Items table — all columns
  const allColumns: { key: string; cfg: PrintColumn; on?: boolean }[] = [
    { key: "idx", cfg: { key: "idx", label: "#", align: "center", width: "5%" }, on: vis.showLineIndex },
    { key: "roll", cfg: { key: "roll", label: "رقم الصبغة", width: "14%" }, on: vis.showRollNumber },
    { key: "fabric", cfg: { key: "fabric", label: "القماش", width: "20%" }, on: vis.showFabric },
    { key: "color", cfg: { key: "color", label: "اللون", width: "18%" }, on: vis.showColorCode || vis.showColorName },
    { key: "pieces", cfg: { key: "pieces", label: "الأثواب", align: "center", width: "7%" }, on: vis.showQuantity },
    { key: "qty", cfg: { key: "qty", label: "الكمية (كغ)", align: "center", width: "11%" }, on: vis.showQuantity },
    { key: "price", cfg: { key: "price", label: "السعر/كغ", align: "left", amount: true, width: "11%" }, on: vis.showUnitPrice },
    { key: "gross", cfg: { key: "gross", label: "الإجمالي", align: "left", amount: true, width: "11%" }, on: vis.showLineTotal },
  ];
  const columns = allColumns.filter((c) => c.on !== false).map((c) => c.cfg);
  const rows = r.lines.map((l, i) => {
    const roll = rollById(l.rollId);
    const col = roll ? colorById(roll.colorId) : null;
    const fab = col ? fabricById(col.fabricId) : null;
    const sub = l.quantityKg * l.pricePerKg;
    const cell: Record<string, string | number | React.ReactNode> = {
      idx: i + 1,
      roll: roll ? roll.rollNo : "—",
      fabric: fab?.name ?? "—",
      color: renderRollColorCell(l.rollId),
      pieces: (l.pieces && l.pieces > 1) ? String(l.pieces) : "—",
      qty: fmtQty(l.quantityKg),
      price: fmtUnit(l.pricePerKg),
      gross: fmtMoney(sub),
    };
    return columns.map((c) => cell[c.key] ?? "—");
  });
  const totals: PrintTotal[] = [];
  if (vis.showGrandTotal) {
    totals.push({ label: "إجمالي المرتجع", value: `${fmtMoney(total)} ${sym}`, grand: true });
  }
  const partyBlock: PrintParty | undefined = vis.showPartyName
    ? {
        label: isSupplierReturn ? "المورّد" : "العميل",
        name: party?.name ?? (isSupplierReturn ? "مورّد غير معرّف" : "عميل غير معرّف"),
        ...(vis.showPartyPhone && party?.phone ? { phone: party.phone } : {}),
        ...(vis.showPartyAddress && (party?.address || party?.city)
          ? { address: [party.address, party.city].filter(Boolean).join(" — ") }
          : {}),
        ...(vis.showPartyCode && party?.code
          ? { extra: `${isSupplierReturn ? "رمز المورّد" : "رمز العميل"}: ${party.code}` }
          : {}),
      }
    : undefined;
  return (
    <PrintDocument
      title={KIND_TITLE[r.kind]}
      subtitle={KIND_SUBTITLE[r.kind]}
      meta={meta}
      party={partyBlock}
      totals={totals}
      notes={vis.showNotes ? r.notesPrint ?? undefined : undefined}
      signatures={vis.showSignatures ? ["توقيع المستلم", "ختم الشركة"] : undefined}
      pageNumber={pageNumber}
      totalPages={totalPages}
      typeBadge={vis.showTypeBadge ? KIND_BADGE[r.kind] : undefined}
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
