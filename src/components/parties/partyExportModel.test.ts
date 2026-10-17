import { describe, expect, it } from "vitest";
import type { Party } from "@/domain/entities/Party";
import { buildPartyExportModel, partyExportCsvRows } from "./partyExportModel";

function party(over: Partial<Party> & { id: string; name: string }): Party {
  return {
    status: "active",
    phone: "",
    code: "C-" + over.id,
    stats: undefined,
    ...over,
  } as unknown as Party;
}

const customerA = party({
  id: "1",
  name: "أحمد",
  phone: "0944",
  code: "C-001",
  stats: {
    invoicesCount: 2,
    totalAmount: 0,
    totalPaid: 0,
    remaining: 0,
    byCurrency: {
      SYP: { invoicesCount: 1, totalAmount: 0, totalPaid: 0, remaining: 1500 },
      USD: { invoicesCount: 1, totalAmount: 0, totalPaid: 0, remaining: -40 },
    },
  },
});

const customerB = party({
  id: "2",
  name: "سارة",
  stats: {
    invoicesCount: 0,
    totalAmount: 0,
    totalPaid: 0,
    remaining: 0,
    byCurrency: {},
  },
});

const cancelled = party({
  id: "3",
  name: "ملغى",
  status: "cancelled",
  stats: {
    invoicesCount: 0,
    totalAmount: 0,
    totalPaid: 0,
    remaining: 0,
    byCurrency: { SYP: { invoicesCount: 0, totalAmount: 0, totalPaid: 0, remaining: 999 } },
  },
});

describe("buildPartyExportModel", () => {
  it("emits one row per live party, with the index", () => {
    const m = buildPartyExportModel([customerA, customerB, cancelled], "customer");
    expect(m.rows.map((r) => r.name)).toEqual(["أحمد", "سارة"]);
    expect(m.rows.map((r) => r.index)).toEqual([1, 2]);
    expect(m.partyCount).toBe(2);
  });

  it("excludes cancelled (soft-deleted) parties from rows and totals", () => {
    const m = buildPartyExportModel([cancelled], "customer");
    expect(m.rows).toHaveLength(0);
    expect(m.summaryByCurrency).toHaveLength(0);
  });

  it("keeps currencies separate and never blends SYP with USD", () => {
    const m = buildPartyExportModel([customerA], "customer");
    const row = m.rows[0];
    expect(row.balances.map((b) => b.currency)).toEqual(["SYP", "USD"]);
    const syp = row.balances.find((b) => b.currency === "SYP")!;
    const usd = row.balances.find((b) => b.currency === "USD")!;
    expect(syp).toMatchObject({ receivable: 1500, payable: 0, net: 1500 });
    expect(usd).toMatchObject({ receivable: 0, payable: 40, net: -40 });
  });

  it("flips the sign for suppliers: a positive remaining is payable", () => {
    const supplier = party({
      id: "9",
      name: "مورد",
      stats: {
        invoicesCount: 1,
        totalAmount: 0,
        totalPaid: 0,
        remaining: 0,
        byCurrency: { SYP: { invoicesCount: 1, totalAmount: 0, totalPaid: 0, remaining: 800 } },
      },
    });
    const m = buildPartyExportModel([supplier], "supplier");
    expect(m.rows[0].balances[0]).toMatchObject({ receivable: 0, payable: 800, net: -800 });
  });

  it("summarises totals per currency (receivables, payables, net) with no cross-currency sum", () => {
    // A second customer owing SYP 500 and owed USD 10 (a credit balance): totals stay per currency.
    const customerC = party({
      id: "4",
      name: "خالد",
      stats: {
        invoicesCount: 1,
        totalAmount: 0,
        totalPaid: 0,
        remaining: 0,
        byCurrency: {
          SYP: { invoicesCount: 1, totalAmount: 0, totalPaid: 0, remaining: 500 },
          USD: { invoicesCount: 1, totalAmount: 0, totalPaid: 0, remaining: -10 },
        },
      },
    });
    const m = buildPartyExportModel([customerA, customerC], "customer");
    const syp = m.summaryByCurrency.find((s) => s.currency === "SYP")!;
    const usd = m.summaryByCurrency.find((s) => s.currency === "USD")!;
    expect(syp).toMatchObject({ receivable: 2000, payable: 0, net: 2000 });
    expect(usd).toMatchObject({ receivable: 0, payable: 50, net: -50 });
    expect(m.summaryByCurrency.map((s) => s.currency)).toEqual(["SYP", "USD"]);
  });

  it("uses an empty balance cell list for a party without currency stats", () => {
    const m = buildPartyExportModel([customerB], "customer");
    expect(m.rows[0].balances).toEqual([]);
  });
});

describe("partyExportCsvRows", () => {
  it("writes one line per party-currency pair plus a total line per currency", () => {
    const m = buildPartyExportModel([customerA, customerB], "customer");
    const rows = partyExportCsvRows(m);
    // header + (A: SYP, USD) + (B: no balance -> one zero line) + 2 totals
    expect(rows).toHaveLength(1 + 2 + 1 + 2);
    expect(rows[0][0]).toBe("#");
    const sypLine = rows.find((r) => r[4] === "SYP" && r[2] === "أحمد")!;
    expect(sypLine.slice(5)).toEqual(["1,500.00", "0.00", "1,500.00"]);
    const totalSyp = rows[rows.length - 2];
    expect(totalSyp[2]).toBe("الإجمالي");
    expect(totalSyp[4]).toBe("SYP");
  });

  it("formats amounts with two decimals, a thousands separator, and a minus sign", () => {
    const m = buildPartyExportModel([customerA], "customer");
    const usdLine = partyExportCsvRows(m).find((r) => r[4] === "USD" && r[2] === "أحمد")!;
    expect(usdLine.slice(5)).toEqual(["0.00", "40.00", "-40.00"]);
  });
});
