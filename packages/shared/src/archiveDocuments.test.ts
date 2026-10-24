import { describe, it, expect } from "vitest";
import {
  buildCashboxBody,
  buildInvoiceBody,
  buildStatementBody,
  escapeHtml,
  fmtMoney,
  orderStatementLegs,
  runningBalances,
  wrapArchiveDocument,
  type ArchiveInvoiceHeader,
  type ArchiveLeg,
} from "./archiveDocuments.js";

const header = (over: Partial<ArchiveInvoiceHeader> = {}): ArchiveInvoiceHeader => ({
  kind: "sale",
  number: "INV-0042",
  date: "2026-10-14",
  partyName: "مؤسسة النور",
  currency: "SYP",
  subtotal: 300,
  discount: 10,
  tax: 0,
  shipping: 0,
  total: 290,
  paid: 100,
  cancelled: false,
  ...over,
});

const line = {
  fabric: "قماش قطني",
  color: "أزرق",
  rollNo: "R-1",
  pieces: 2,
  quantityKg: 100,
  pricePerKg: 3,
  discountAmount: 0,
  lineTotal: 300,
};

describe("escapeHtml", () => {
  it("escapes markup in user-entered names and notes", () => {
    expect(escapeHtml("<script>alert(\"x\")</script> & 'y'")).toBe(
      "&lt;script&gt;alert(&quot;x&quot;)&lt;/script&gt; &amp; &#39;y&#39;",
    );
  });

  it("renders null and undefined as empty text", () => {
    expect(escapeHtml(null)).toBe("");
    expect(escapeHtml(undefined)).toBe("");
  });
});

describe("money", () => {
  it("rounds to 2 decimals with the shared helper and prints 2 decimals", () => {
    expect(fmtMoney(1.005)).toBe("1.01");
    expect(fmtMoney(2)).toBe("2.00");
    expect(fmtMoney(null)).toBe("0.00");
    expect(fmtMoney("abc")).toBe("0.00");
  });
});

describe("wrapArchiveDocument", () => {
  it("is a complete RTL document with the paper size and no scripts or external links", () => {
    const html = wrapArchiveDocument({ title: "t", bodyHtml: "<p>x</p>", paper: "A5" });
    expect(html).toContain('dir="rtl"');
    expect(html).toContain('data-paper="A5"');
    expect(html).toContain("A5 portrait");
    expect(html).toContain("<p>x</p>");
    expect(html).not.toMatch(/<script/i);
    expect(html).not.toMatch(/https?:\/\//);
  });

  it("escapes the document title", () => {
    const html = wrapArchiveDocument({ title: '<b>"x"</b>', bodyHtml: "", paper: "A4" });
    expect(html).toContain("&lt;b&gt;&quot;x&quot;&lt;/b&gt;");
  });
});

describe("invoice body", () => {
  it("lists every roll line with its kilograms and line total", () => {
    const html = buildInvoiceBody(header(), [line, { ...line, rollNo: "R-2", lineTotal: 150 }]);
    expect(html).toContain("R-1");
    expect(html).toContain("R-2");
    expect(html).toContain("300.00");
    expect(html).toContain("150.00");
    expect(html).toContain("عدد الأسطر: 2");
  });

  it("shows the paid and remaining amounts from the stored document", () => {
    const html = buildInvoiceBody(header({ total: 290, paid: 100 }), [line]);
    expect(html).toContain("المتبقي");
    expect(html).toContain("190.00");
  });

  it("never reports a negative remaining amount on an over-payment", () => {
    const html = buildInvoiceBody(header({ total: 100, paid: 150 }), [line]);
    expect(html).toContain('المتبقي</td><td class="arc-num">0.00');
  });

  it("marks a cancelled document and keeps it printed", () => {
    const html = buildInvoiceBody(header({ cancelled: true }), [line]);
    expect(html).toContain("(ملغاة)");
    expect(html).toContain("arc-cancelled");
  });

  it("escapes a hostile party name and line note", () => {
    const html = buildInvoiceBody(header({ partyName: "<img src=x onerror=1>" }), [
      { ...line, note: "<script>x</script>" },
    ]);
    expect(html).not.toContain("<img src=x");
    expect(html).not.toContain("<script>x</script>");
    expect(html).toContain("&lt;img");
  });
});

describe("statement order", () => {
  const leg = (over: Partial<ArchiveLeg>): ArchiveLeg => ({
    date: "2026-10-01",
    createdAt: "2026-10-01T09:00:00Z",
    docRank: 1,
    id: "a",
    type: "invoice",
    reference: "INV-1",
    description: "",
    debit: 0,
    credit: 0,
    status: "active",
    ...over,
  });

  it("orders by (date, createdAt, docRank, id)", () => {
    const ordered = orderStatementLegs([
      leg({ id: "z", date: "2026-10-02" }),
      leg({ id: "b", docRank: 2 }),
      leg({ id: "a", docRank: 1 }),
      leg({ id: "c", createdAt: "2026-10-01T08:00:00Z" }),
    ]).map((l) => l.id);
    expect(ordered).toEqual(["c", "a", "b", "z"]);
  });

  it("puts an invoice (rank 1) before the payment booked with it (rank 2) in the same instant", () => {
    const ordered = orderStatementLegs([
      leg({ id: "pay", docRank: 2, type: "payment" }),
      leg({ id: "inv", docRank: 1, type: "invoice" }),
    ]).map((l) => l.id);
    expect(ordered).toEqual(["inv", "pay"]);
  });

  it("does not mutate its input", () => {
    const input = [leg({ id: "b" }), leg({ id: "a" })];
    orderStatementLegs(input);
    expect(input.map((l) => l.id)).toEqual(["b", "a"]);
  });
});

describe("running balances", () => {
  const base: ArchiveLeg = {
    date: "2026-10-01",
    createdAt: "t",
    docRank: 1,
    id: "x",
    type: "invoice",
    reference: "",
    description: "",
    debit: 0,
    credit: 0,
    status: "active",
  };

  it("adds debits and subtracts credits from the opening balance", () => {
    const out = runningBalances(
      [
        { ...base, id: "1", debit: 100 },
        { ...base, id: "2", credit: 30 },
      ],
      10,
    );
    expect(out.map((r) => r.balance)).toEqual([110, 80]);
  });

  it("a cancelled leg is printed but moves the balance by nothing", () => {
    const out = runningBalances(
      [
        { ...base, id: "1", debit: 100 },
        { ...base, id: "2", debit: 50, status: "cancelled" },
      ],
      0,
    );
    expect(out.map((r) => r.balance)).toEqual([100, 100]);
  });

  it("keeps money exact to 2 decimals across many small legs", () => {
    const legs = Array.from({ length: 10 }, (_, i) => ({ ...base, id: `${i}`, debit: 0.1 }));
    const out = runningBalances(legs, 0);
    expect(out[out.length - 1].balance).toBe(1);
  });
});

describe("statement body", () => {
  it("prints the party, the period, and a closing balance from the active legs", () => {
    const html = buildStatementBody({
      partyName: "مؤسسة النور",
      partyKind: "customer",
      currency: "SYP",
      periodFrom: "2026-10-01",
      periodTo: "2026-10-31",
      opening: 0,
      legs: [
        {
          date: "2026-10-03",
          createdAt: "a",
          docRank: 1,
          id: "1",
          type: "invoice",
          reference: "INV-1",
          description: "",
          debit: 500,
          credit: 0,
          status: "active",
        },
        {
          date: "2026-10-05",
          createdAt: "b",
          docRank: 2,
          id: "2",
          type: "payment",
          reference: "RC-1",
          description: "",
          debit: 0,
          credit: 200,
          status: "active",
        },
      ],
    });
    expect(html).toContain("كشف حساب عميل");
    expect(html).toContain("مؤسسة النور");
    expect(html).toContain("300.00");
  });
});

describe("cashbox body", () => {
  it("keeps each currency separate and never adds across them", () => {
    const html = buildCashboxBody({
      period: "2026-10",
      openingByCurrency: { SYP: 1000, USD: 50 },
      rows: [
        {
          date: "2026-10-02",
          createdAt: "a",
          docRank: 1,
          id: "1",
          type: "receipt",
          description: "",
          currency: "SYP",
          cashIn: 500,
          cashOut: 0,
          status: "active",
        },
        {
          date: "2026-10-02",
          createdAt: "b",
          docRank: 1,
          id: "2",
          type: "payment",
          description: "",
          currency: "USD",
          cashIn: 0,
          cashOut: 20,
          status: "active",
        },
      ],
    });
    expect(html).toContain("الصندوق — SYP");
    expect(html).toContain("الصندوق — USD");
    // SYP: 1000 + 500 = 1500 closing. USD: 50 - 20 = 30 closing.
    expect(html).toContain("1500.00");
    expect(html).toContain("30.00");
    expect(html).not.toContain("1530");
  });

  it("states that the month has no movements when there are none", () => {
    const html = buildCashboxBody({ period: "2026-10", rows: [], openingByCurrency: {} });
    expect(html).toContain("لا توجد حركات في هذه الفترة");
  });
});
