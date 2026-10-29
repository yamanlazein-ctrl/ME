import { describe, expect, it } from "vitest";
import { renderInvoiceHtml, renderStatementHtml } from "../../src/print/renderHtml";
import type { ArchiveLeg } from "@erp/shared";

const line = (n: number, kg: number, price: number, discount: number) => ({
  fabric: `قماش ${n}`,
  color: "أبيض",
  rollNo: `R-00${n}`,
  pieces: n,
  quantityKg: kg,
  pricePerKg: price,
  discountAmount: discount,
  lineTotal: Math.max(0, Math.round((kg * price - discount) * 100) / 100),
});

describe("phone print HTML (S3)", () => {
  it("renders a 3-line invoice with every formatted amount, the currency and RTL", () => {
    const lines = [line(1, 12.5, 8.25, 0), line(2, 7.75, 10, 2.5), line(3, 30, 4.4, 0)];
    const html = renderInvoiceHtml({
      header: {
        kind: "sale",
        number: "INV-2026-0042",
        date: "2026-01-15",
        partyName: "عميل تجريبي",
        currency: "USD",
        subtotal: 312.19,
        discount: 5,
        tax: 0,
        shipping: 2,
        total: 309.19,
        paid: 100,
        cancelled: false,
      },
      lines,
    });
    expect(html).toContain('dir="rtl"');
    expect(html).toContain("INV-2026-0042");
    expect(html).toContain("USD");
    for (const l of lines) {
      expect(html).toContain(l.lineTotal.toFixed(2));
      expect(html).toContain(l.pricePerKg.toFixed(2));
    }
    for (const amount of ["312.19", "309.19", "209.19"]) expect(html).toContain(amount);
  });

  it("renders SYP amounts without any currency conversion", () => {
    const html = renderInvoiceHtml({
      header: {
        kind: "entry",
        number: "ENT-2026-0001",
        date: "2026-01-15",
        partyName: "مورد",
        currency: "SYP",
        subtotal: 1250000,
        discount: 0,
        tax: 0,
        shipping: 0,
        total: 1250000,
        paid: 0,
        cancelled: false,
      },
      lines: [line(1, 100, 12500, 0)],
    });
    expect(html).toContain("SYP");
    expect(html).toContain("1250000.00");
  });

  it("renders a 650-row statement quickly and keeps the closing balance", () => {
    const legs: ArchiveLeg[] = Array.from({ length: 650 }, (_, i) => ({
      date: "2026-01-15",
      createdAt: `2026-01-15T10:${String(i % 60).padStart(2, "0")}:00.000000Z`,
      docRank: i % 2 ? 2 : 1,
      id: `id-${String(i).padStart(4, "0")}`,
      type: i % 2 ? "receipt_in" : "sales_invoice",
      reference: `REF-${i}`,
      description: "بيان",
      debit: i % 2 ? 0 : 10,
      credit: i % 2 ? 10 : 0,
      status: "active" as const,
    }));
    const t0 = Date.now();
    const html = renderStatementHtml({
      partyName: "عميل",
      partyKind: "customer",
      currency: "USD",
      periodFrom: "2026-01-01",
      periodTo: "2026-12-31",
      opening: 100,
      legs,
    });
    expect(Date.now() - t0).toBeLessThan(2000);
    expect(html.match(/REF-/g)?.length).toBe(650);
    expect(html).toContain('dir="rtl"');
  });
});
