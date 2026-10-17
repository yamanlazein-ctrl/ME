import { describe, it, expect } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { LedgerPrintDocument, type LedgerPrintRow } from "./LedgerPrintDocument";

const row = (over: Partial<LedgerPrintRow> = {}): LedgerPrintRow => ({
  id: "1",
  createdAt: "2026-10-15T09:00:00.000Z",
  type: "receipt_in",
  description: "سند قبض",
  referenceNumber: "R-1",
  partyName: "يي",
  debit: 0,
  credit: 20000,
  currency: "USD",
  cashImpact: "in",
  status: "active",
  ...over,
});

const html = (rows: LedgerPrintRow[], filterSummary = "كل الفترات") =>
  renderToStaticMarkup(
    <LedgerPrintDocument rows={rows} filterSummary={filterSummary} dateLabel="2026-10-15" />,
  );

describe("LedgerPrintDocument", () => {
  it("renders the standard ERP title and the filter summary", () => {
    const out = html([row()], "النوع: سند قبض");
    expect(out).toContain("دفتر الحركات المركزي");
    expect(out).toContain("النوع: سند قبض");
  });

  it("prints the Arabic currency symbol, never the raw ISO code", () => {
    const out = html([row({ currency: "USD" }), row({ id: "2", currency: "SYP", credit: 5 })]);
    expect(out).toContain("$");
    expect(out).toContain("ل.س");
    expect(out).not.toMatch(/>USD</);
    expect(out).not.toMatch(/>SYP</);
  });

  it("totals are per currency and skip cancelled rows", () => {
    const out = html([
      row({ credit: 100, currency: "USD" }),
      row({ id: "2", credit: 999, currency: "USD", status: "cancelled" }),
      row({ id: "3", credit: 7, currency: "SYP" }),
    ]);
    expect(out).toContain("إجمالي دائن $");
    expect(out).toContain("إجمالي دائن ل.س");
    // The cancelled row is still listed (struck through), but never counted in the totals:
    // the USD total is 100, not 1,099.
    const usdTotal = out.slice(out.indexOf("إجمالي دائن $"), out.indexOf("إجمالي دائن $") + 300);
    expect(usdTotal).toContain("100");
    expect(usdTotal).not.toContain("1,099");
    expect(usdTotal).not.toContain("999");
  });

  it("an empty result prints a clear message instead of an empty table", () => {
    const out = html([]);
    expect(out).toContain("لا حركات مطابقة للفلاتر");
    expect(out).toContain("عدد الحركات");
  });
});
