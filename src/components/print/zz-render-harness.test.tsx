// TEMPORARY visual harness (deleted after verification): renders print documents to standalone HTML
// with the real print.css, for Chromium to print. Not a test of its own.
import { it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

vi.mock("@/presentation/hooks/useSettings", () => ({
  useSettings: () => ({
    company: { name: "Motard Fabrics Group", phone: "021 26 64 629 · 0933 70 35 73" },
    printing: { showLogo: true, paperSize: process.env.HARNESS_PAPER || "A4" },
  }),
}));

vi.mock("@/presentation/hooks/useInventory", () => ({
  useInventory: () => undefined,
  fabricById: () => ({ name: "قماش قطني مصبوغ عريض للمفروشات" }),
  rollById: () => ({ rollNo: "R-2026-000123" }),
  colorById: () => ({ name: "أزرق ملكي غامق", code: "B-1203", hex: "#123" }),
}));
vi.mock("@/presentation/hooks/useParties", () => ({
  customerById: () => ({
    id: "c1",
    name: "شركة النسيج المتحدة",
    code: "CUS-2026-0001",
    phone: "0999 123 456",
    address: "حلب",
  }),
  supplierById: () => ({ id: "s1", name: "مورد", code: "SUP-1", phone: "0888", address: "حلب" }),
}));
vi.mock("@/presentation/hooks/useVouchers", () => ({
  useVouchersList: () => ({ data: { data: [] } }),
}));
vi.mock("@/components/print/invoices/visibility", () => {
  const keys = [
    "showInvoiceNumber",
    "showDate",
    "showStatus",
    "showCurrency",
    "showCreatedBy",
    "showCancelledInfo",
    "showTypeBadge",
    "showPartyName",
    "showPartyPhone",
    "showPartyAddress",
    "showPartyCode",
    "showSubtotal",
    "showDiscountTotal",
    "showTax",
    "showGrandTotal",
    "showPaymentSummary",
    "showPaymentMethod",
    "showNotes",
    "showSignatures",
    "showFooter",
  ];
  const vis = Object.fromEntries(keys.map((k) => [k, true]));
  return { useInvoiceVisibility: () => vis };
});

const OUT = process.env.HARNESS_OUT || "";

it.skipIf(!OUT)("render", async () => {
  const { PartyStatementDocument } = await import("./PartyStatementDocument");
  const css = readFileSync(join(__dirname, "print.css"), "utf8");
  const page = (
    body: string,
    orientation: string,
  ) => `<!doctype html><html lang="ar" dir="rtl"><head><meta charset="utf-8">
<style>${css}</style><style>@page{size:A4 ${orientation};margin:0} body{margin:0;font-family:"Segoe UI",Tahoma,Arial,sans-serif}</style></head>
<body><div data-print-root>${body}</div></body></html>`;
  const rows = [
    {
      seq: 1,
      date: "2026-10-14",
      type: "opening",
      referenceNumber: "CUS-2026-0001",
      description: "الرصيد الافتتاحي",
      debit: 32900.13,
      credit: 0,
      runningBalance: 32900.13,
      currencySymbol: "$",
    },
    {
      seq: 2,
      date: "2026-10-14",
      type: "sale_invoice",
      referenceNumber: "INV-2026-0001",
      description: "فاتورة مبيع أقمشة قطنية مصبوغة بألوان متعددة حسب الطلب",
      quantityKg: 125.5,
      pricePerKg: 4.25,
      debit: 533.38,
      credit: 0,
      runningBalance: 33433.51,
      currencySymbol: "$",
      originalAmount: "6,934,940 ل.س",
      exchangeRate: "13,000",
    },
    {
      seq: 3,
      date: "2026-10-15",
      type: "receipt",
      referenceNumber: "RCV-2026-0012",
      description: "دفعة نقدية",
      debit: 0,
      credit: 1250000,
      runningBalance: -1250000,
      currencySymbol: "ل.س",
    },
    {
      seq: 4,
      date: "2026-10-16",
      type: "payment",
      referenceNumber: "PAY-2026-0003",
      description: "تسديد",
      debit: 0,
      credit: 33433.51,
      runningBalance: 0,
      currencySymbol: "$",
      status: "cancelled" as const,
    },
  ];
  const multi = renderToStaticMarkup(
    <PartyStatementDocument
      partyName="شركة النسيج المتحدة للتجارة العامة"
      partyCode="CUS-2026-0001"
      period="البداية — اليوم"
      currency="متعدد"
      previousBalance={0}
      rows={rows}
      totals={{ debit: 0, credit: 0, running: 0 }}
      totalsByCurrency={[
        { symbol: "$", debit: 33433.51, credit: 33433.51, running: 0 },
        { symbol: "ل.س", debit: 0, credit: 1250000, running: -1250000 },
      ]}
    />,
  );
  writeFileSync(join(OUT, "statement-multi.html"), page(multi, "landscape"));
  const single = renderToStaticMarkup(
    <PartyStatementDocument
      partyName="عميل اختبار"
      partyCode="CUS-2026-0002"
      period="2026-01-01 — 2026-10-14"
      currency="$"
      previousBalance={1200.5}
      rows={rows.slice(0, 2).map((r) => ({ ...r, currencySymbol: undefined }))}
      totals={{ debit: 33433.51, credit: 0, running: 34634.01 }}
    />,
  );
  writeFileSync(join(OUT, "statement-single.html"), page(single, "landscape"));
  const { InvoicePrintDocument } = await import("./InvoicePrintDocument");
  const { Invoice } = await import("@/domain/entities/Invoice");
  const inv = Invoice.create({
    tenantId: "t1",
    number: "INV-2026-000123",
    type: "sale",
    date: "2026-10-14",
    partyId: "c1",
    partyType: "customer",
    currency: "SYP",
    exchangeRate: 13_000,
    baseTotal: 0,
    lines: [1, 2, 3].map((i) => ({
      id: `l${i}`,
      fabricId: "f1",
      colorId: "col1",
      rollId: "r1",
      quantityKg: 125.55 * i,
      pieces: 3 * i,
      pricePerKg: 48_500.5,
      discountAmount: 0,
    })),
    paid: 0,
    createdAt: "2026-10-14T00:00:00.000Z",
    createdBy: "u1",
  } as never);
  const invoice = renderToStaticMarkup(<InvoicePrintDocument invoice={inv as never} />);
  writeFileSync(join(OUT, "invoice-portrait.html"), page(invoice, "portrait"));
});
