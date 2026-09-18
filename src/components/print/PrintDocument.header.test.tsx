/**
 * Canonical print header: company identity once, five verbatim contact
 * lines, logo isolated. Settings must not duplicate the name or scramble
 * phones into the address via a concatenated LTR line.
 */
import { describe, it, expect, vi } from "vitest";
import React from "react";
import { renderToString } from "react-dom/server";
import { FIXED_PRINT_FOOTER_LINES, PRINT_BRAND_NAME } from "@/shared/constants/printConfig";

vi.mock("@/presentation/hooks/useSettings", () => ({
  useSettings: () => ({
    company: {
      name: "Motard Fabrics Group",
      nameEn: "Motard Fabrics Group",
      commercialReg: "SHOULD-NOT-PRINT",
      taxNumber: "SHOULD-NOT-PRINT",
      phone: "021 26 64 629 · محمود كوكة: 0933 70 35 73 · زكريا كوكة: 0944 88 76 44",
      address: "WRONG ADDRESS LINE THAT MUST NOT APPEAR",
    },
    printing: { showLogo: true, footerNote: "شكراً لتعاملكم معنا" },
  }),
}));

vi.mock("@/presentation/hooks/useInventory", () => ({
  useInventory: () => undefined,
  fabricById: () => ({ name: "قماش اختبار" }),
  rollById: () => ({ rollNo: "R-1" }),
  colorById: () => ({ name: "أبيض", code: "W1", hex: "#fff" }),
}));

vi.mock("@/presentation/hooks/useParties", () => ({
  customerById: () => ({
    id: "c1",
    name: "عميل اختبار",
    code: "C-1",
    phone: "0999",
    address: "حلب",
  }),
  supplierById: () => ({
    id: "s1",
    name: "مورد اختبار",
    code: "S-1",
    phone: "0888",
    address: "حلب",
  }),
}));

vi.mock("@/presentation/hooks/useVouchers", () => ({
  useVouchersList: () => ({ data: { data: [] } }),
}));

vi.mock("@/components/print/invoices/visibility", () => {
  const vis = {
    showInvoiceNumber: true,
    showDate: true,
    showStatus: true,
    showCurrency: true,
    showCreatedBy: true,
    showCancelledInfo: true,
    showTypeBadge: true,
    showPartyName: true,
    showPartyPhone: true,
    showPartyAddress: true,
    showPartyCode: true,
    showSubtotal: true,
    showDiscountTotal: true,
    showTax: true,
    showGrandTotal: true,
    showPaymentSummary: true,
    showPaymentMethod: true,
    showNotes: true,
    showSignatures: true,
    showFooter: true,
  };
  return { useInvoiceVisibility: () => vis };
});

const { PrintDocument } = await import("./PrintDocument");
const { InvoicePrintDocument } = await import("./InvoicePrintDocument");
const { Invoice } = await import("@/domain/entities/Invoice");

function count(html: string, needle: string): number {
  let n = 0;
  let i = 0;
  while (true) {
    const found = html.indexOf(needle, i);
    if (found < 0) return n;
    n += 1;
    i = found + needle.length;
  }
}

function assertCanonicalHeader(html: string) {
  expect(count(html, PRINT_BRAND_NAME)).toBe(1);
  expect(html).not.toContain("print-brand-en");
  expect(html).not.toContain("WRONG ADDRESS");
  expect(html).not.toContain("SHOULD-NOT-PRINT");
  expect(html).not.toContain("0933 70 35 73");
  const brandBlock = html.slice(
    html.indexOf("print-brand-bar"),
    html.indexOf("print-header-divider"),
  );
  expect(brandBlock).not.toContain('dir="ltr"');
  for (const line of FIXED_PRINT_FOOTER_LINES) {
    expect(count(html, line)).toBe(1);
  }
  expect(html).toContain("print-logo");
  expect(html).toContain("print-brand-contact");
  expect(html).toContain("print-brand-name");
  expect(html).toContain("print-brand-identity");
  // Logo first, then identity block (name + contact) — physical LTR columns.
  expect(brandBlock.indexOf("print-logo")).toBeLessThan(
    brandBlock.indexOf("print-brand-identity"),
  );
  expect(brandBlock.indexOf("print-brand-name")).toBeLessThan(
    brandBlock.indexOf("print-brand-contact"),
  );
}

function makeInvoice(type: "sale" | "entry"): Invoice {
  return Invoice.create({
    tenantId: "t1",
    number: type === "sale" ? "SALE-1" : "ENT-1",
    type,
    date: "2026-09-16",
    partyId: type === "sale" ? "c1" : "s1",
    partyType: type === "sale" ? "customer" : "supplier",
    currency: "SYP",
    exchangeRate: 10_000,
    baseTotal: 50,
    lines: [
      {
        id: "l1",
        fabricId: "f1",
        colorId: "col1",
        rollId: "r1",
        quantityKg: 10,
        pieces: 1,
        pricePerKg: 50_000,
        discountAmount: 0,
      },
    ],
    paid: 0,
    createdAt: "2026-09-16T00:00:00.000Z",
    createdBy: "u1",
  });
}

describe("canonical print header", () => {
  it("renders brand once and the five verbatim contact lines", () => {
    const html = renderToString(
      React.createElement(
        PrintDocument,
        { title: "فاتورة بيع" },
        React.createElement("div", null, "body"),
      ),
    );
    assertCanonicalHeader(html);
    expect(html).toContain("فاتورة بيع");
  });

  it("does not repeat contact in the footer", () => {
    const html = renderToString(
      React.createElement(
        PrintDocument,
        { title: "فاتورة بيع" },
        React.createElement("div", null, "body"),
      ),
    );
    const footerIdx = html.indexOf("print-footer");
    expect(footerIdx).toBeGreaterThan(0);
    const footer = html.slice(footerIdx);
    for (const line of FIXED_PRINT_FOOTER_LINES) {
      expect(footer).not.toContain(line);
    }
  });

  it("sale and entry invoices share the same header", () => {
    const sale = renderToString(
      React.createElement(InvoicePrintDocument, { invoice: makeInvoice("sale") }),
    );
    const entry = renderToString(
      React.createElement(InvoicePrintDocument, { invoice: makeInvoice("entry") }),
    );
    assertCanonicalHeader(sale);
    assertCanonicalHeader(entry);
    expect(sale).toContain("فاتورة بيع");
    expect(entry).toContain("فاتورة شراء");
  });
});
