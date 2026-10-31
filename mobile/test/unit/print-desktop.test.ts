// The phone's invoice PDF is the desktop's printed invoice: same stylesheet and logo, same columns, same line details,
// same pages. These tests read the desktop's own source files so the two cannot drift apart silently.
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  LINES_PER_PAGE,
  lineDetails,
  renderDesktopInvoiceHtml,
  type DesktopInvoiceLine,
  type DesktopInvoicePrint,
} from "../../src/print/desktopInvoiceHtml";
import { DESKTOP_LOGO_DATA_URI, DESKTOP_PRINT_CSS } from "../../src/print/generated/desktopPrint";

const root = path.resolve(__dirname, "../../..");
const desktop = (p: string) => readFileSync(path.join(root, p));

/** The column labels a desktop print template declares, in order. */
function desktopColumns(file: string): string[] {
  const src = desktop(file).toString("utf8");
  const block = src.slice(
    src.indexOf("const mainColumns"),
    src.indexOf("];", src.indexOf("const mainColumns")),
  );
  return [...block.matchAll(/label: "([^"]+)"/g)].map((m) => m[1]!);
}

const line = (patch: Partial<DesktopInvoiceLine> = {}): DesktopInvoiceLine => ({
  fabric: "قطن",
  colorName: "أبيض",
  colorCode: "W-1",
  colorHex: "#ffffff",
  rollNo: "R-1",
  pieces: 3,
  quantityKg: 20,
  pricePerKg: 2.5,
  lineTotal: 50,
  ...patch,
});

const doc = (patch: Partial<DesktopInvoicePrint> = {}): DesktopInvoicePrint => ({
  type: "entry",
  number: "ENT-2026-0007",
  reference: "F-501",
  date: "2026-03-01",
  currency: "SYP",
  cancelled: false,
  exchangeRate: 15000,
  baseTotal: 3.33,
  paymentMethod: "transfer",
  party: { name: "مورد الحرير", phone: "0933 111 222", city: "حلب", code: "S-9" },
  lines: [line({ note: "رقم الماكينة: 12 • كراماج: 180 • السحب: 3 • وزن قائم: 21.5" })],
  subtotal: 50000,
  discount: 0,
  tax: 0,
  shipping: 0,
  total: 50000,
  paid: 20000,
  notes: "المرجع: F-501 • طريقة الدفع: تحويل بنكي",
  ...patch,
});

describe("phone invoice PDF = the desktop's printed invoice", () => {
  it("uses the desktop's print stylesheet and logo unchanged (re-run `npm run gen:print` if this fails)", () => {
    expect(DESKTOP_PRINT_CSS).toBe(desktop("src/components/print/print.css").toString("utf8"));
    expect(DESKTOP_LOGO_DATA_URI).toBe(
      `data:image/png;base64,${desktop("src/assets/logo-motard-icon.png").toString("base64")}`,
    );
  });

  it("has the desktop templates' columns, in order, for purchase and sale", () => {
    const headers = (html: string) =>
      [...html.matchAll(/<th[^>]*>([^<]+)<\/th>/g)].map((m) => m[1]);
    expect(headers(renderDesktopInvoiceHtml(doc()))).toEqual(
      desktopColumns("src/components/print/invoices/EntryInvoicePrint.tsx"),
    );
    expect(headers(renderDesktopInvoiceHtml(doc({ type: "sale" })))).toEqual(
      desktopColumns("src/components/print/invoices/SaleInvoicePrint.tsx"),
    );
  });

  it("header, party, meta, details, totals, payment strip, notes and signatures like the desktop", () => {
    const html = renderDesktopInvoiceHtml(doc());
    for (const text of [
      "Motard Fabrics Group",
      "فاتورة شراء",
      "PURCHASE",
      "إدخال بضاعة إلى المخزون",
      "المورّد",
      "مورد الحرير",
      "الرمز: S-9",
      "رقم الفاتورة",
      "F-501",
      "الحالة",
      "مفتوحة",
      "سعر الصرف",
      "المعادل بالدولار",
      "طريقة الدفع",
      "تحويل بنكي",
      "#R-1",
      "W-1",
      "رقم الماكينة",
      "الكراماج",
      "180",
      "السحب",
      "الإجمالي النهائي",
      "المدفوع",
      "المتبقي",
      "ملاحظات:",
      "توقيع المستلم",
      "ختم الشركة",
      "شكراً لتعاملكم معنا",
    ]) {
      expect(html, text).toContain(text);
    }
    const sale = renderDesktopInvoiceHtml(doc({ type: "sale", cancelled: true }));
    for (const text of [
      "فاتورة بيع",
      "SALE",
      "العميل",
      "عدد الأثواب",
      "المقبوض",
      "الباقي",
      "ملغاة",
    ]) {
      expect(sale, text).toContain(text);
    }
    // The desktop's sale template has no exchange-rate line.
    expect(sale).not.toContain("سعر الصرف");
  });

  it("line details: from the note; the lot's grammage when the note has no كراماج", () => {
    expect(lineDetails(line({ note: "رقم الماكينة: 4 • مرجعية: M-1" }))).toEqual([
      { label: "رقم الماكينة", value: "4" },
      { label: "المرجعية", value: "M-1" },
    ]);
    expect(lineDetails(line({ note: null, weightGsm: 210 }))).toEqual([
      { label: "الكراماج", value: "210" },
    ]);
    expect(lineDetails(line({ note: null }))).toEqual([]);
  });

  it("10 lines a page; later pages say «تابع — صفحة n من N»; totals only on the last page", () => {
    const lines = Array.from({ length: LINES_PER_PAGE + 3 }, (_, i) => line({ rollNo: `R-${i}` }));
    const html = renderDesktopInvoiceHtml(doc({ lines }));
    expect(html.match(/class="print-doc"/g)).toHaveLength(2);
    expect(html).toContain("تابع — صفحة 2 من 2");
    expect(html.match(/class="print-total-row print-grand-total"/g)).toHaveLength(1);
  });

  it("escapes what users typed", () => {
    const html = renderDesktopInvoiceHtml(doc({ party: { name: "<b>x</b>" }, notes: "a<script>" }));
    expect(html).not.toContain("<b>x</b>");
    expect(html).not.toContain("a<script>");
  });
});
