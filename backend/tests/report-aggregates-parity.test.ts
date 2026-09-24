/**
 * The report screens used to compute their figures in the browser from full
 * row sets. They now come from SQL (reportAggregates.ts). This locks PARITY:
 * the old browser formulas, applied to the same rows, must give exactly the
 * figures the server returns — per currency, cancelled excluded, period
 * `date >= from`, fixed-amount discounts, gross top-fabric revenue.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { invoiceTotal, round2dp } from "@erp/shared";
import { db } from "@/infrastructure/orm/drizzle.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import { parties } from "@/infrastructure/orm/schemas/party.table.js";
import { fabrics } from "@/infrastructure/orm/schemas/fabric.table.js";
import { colors } from "@/infrastructure/orm/schemas/color.table.js";
import { rolls } from "@/infrastructure/orm/schemas/roll.table.js";
import { invoices } from "@/infrastructure/orm/schemas/invoice.table.js";
import { invoiceLines } from "@/infrastructure/orm/schemas/invoice-line.table.js";
import { returns } from "@/infrastructure/orm/schemas/return.table.js";
import { returnLines } from "@/infrastructure/orm/schemas/return-line.table.js";
import { expenses } from "@/infrastructure/orm/schemas/expense.table.js";
import * as agg from "@/infrastructure/repositories/reportAggregates.js";

const tenantId = randomUUID();
const cust = [randomUUID(), randomUUID()];
const supplier = randomUUID();
const fab = [randomUUID(), randomUUID()];
const col = [randomUUID(), randomUUID()];
const roll = [randomUUID(), randomUUID()];
const FROM = "2026-06-01";

type L = { fabric: 0 | 1; qty: number; price: number; disc: number };
type Inv = {
  type: "sale" | "entry"; party: string; ccy: "USD" | "SYP"; date: string;
  status: "active" | "cancelled"; lines: L[]; discount: number; tax: number; shipping: number; paid: number;
};
const INVS: Inv[] = [
  { type: "sale", party: cust[0]!, ccy: "USD", date: "2026-07-01", status: "active", lines: [{ fabric: 0, qty: 10.5, price: 3.33, disc: 1.25 }, { fabric: 1, qty: 4, price: 7, disc: 0 }], discount: 2, tax: 1.5, shipping: 3, paid: 20 },
  { type: "sale", party: cust[0]!, ccy: "SYP", date: "2026-07-02", status: "active", lines: [{ fabric: 0, qty: 20, price: 15000, disc: 5000 }], discount: 1000, tax: 0, shipping: 0, paid: 400000 },
  { type: "sale", party: cust[1]!, ccy: "USD", date: "2026-05-20", status: "active", lines: [{ fabric: 1, qty: 3, price: 9.99, disc: 0 }], discount: 0, tax: 0, shipping: 0, paid: 0 },
  { type: "sale", party: cust[1]!, ccy: "USD", date: "2026-07-03", status: "cancelled", lines: [{ fabric: 1, qty: 50, price: 10, disc: 0 }], discount: 0, tax: 0, shipping: 0, paid: 0 },
  { type: "sale", party: cust[1]!, ccy: "SYP", date: "2026-08-10", status: "active", lines: [{ fabric: 1, qty: 12.25, price: 20000, disc: 0 }], discount: 0, tax: 2500, shipping: 0, paid: 300000 },
  { type: "entry", party: supplier, ccy: "USD", date: "2026-07-05", status: "active", lines: [{ fabric: 0, qty: 100, price: 2.5, disc: 0 }], discount: 5, tax: 0, shipping: 10, paid: 100 },
];
const RETS = [
  { kind: "sale", party: cust[0]!, ccy: "USD", date: "2026-07-10", status: "active", lines: [{ qty: 1.5, price: 3.33 }, { qty: 1, price: 7 }] },
  { kind: "sale", party: cust[1]!, ccy: "SYP", date: "2026-05-01", status: "active", lines: [{ qty: 2, price: 20000 }] },
  { kind: "sale", party: cust[1]!, ccy: "SYP", date: "2026-08-11", status: "cancelled", lines: [{ qty: 5, price: 20000 }] },
  { kind: "entry", party: supplier, ccy: "USD", date: "2026-07-06", status: "active", lines: [{ qty: 3, price: 2.5 }] },
] as const;
const EXPS = [
  { ccy: "USD", amount: 12.75, date: "2026-07-01", status: "active" },
  { ccy: "SYP", amount: 50000, date: "2026-06-15", status: "active" },
  { ccy: "SYP", amount: 99999, date: "2026-06-16", status: "cancelled" },
  { ccy: "USD", amount: 5, date: "2026-01-01", status: "active" },
] as const;

const inRange = (d: string, from: string | null) => (from ? d >= from : true);
const totalOf = (i: Inv) =>
  invoiceTotal({
    lines: i.lines.map((l) => ({ quantityKg: l.qty, pricePerKg: l.price, discountAmount: l.disc })) as never,
    discount: i.discount, tax: i.tax, shipping: i.shipping,
  });
function group<T>(xs: readonly T[], amt: (x: T) => number, ccy: (x: T) => string) {
  const out: Record<string, number> = {};
  for (const x of xs) out[ccy(x)] = round2dp((out[ccy(x)] ?? 0) + amt(x));
  return out;
}

beforeAll(async () => {
  await db.insert(tenants).values({ id: tenantId, name: "Parity", slug: `parity-${tenantId.slice(0, 8)}` });
  await db.insert(parties).values([
    { id: cust[0]!, tenantId, name: "زبون أ", code: "PA", kind: "customer", currency: "USD" },
    { id: cust[1]!, tenantId, name: "زبون ب", code: "PB", kind: "customer", currency: "SYP" },
    { id: supplier, tenantId, name: "مورد", code: "PS", kind: "supplier", currency: "USD" },
  ] as never);
  await db.insert(fabrics).values(fab.map((id, n) => ({ id, tenantId, name: `قماش ${n}` })) as never);
  await db.insert(colors).values(col.map((id, n) => ({ id, tenantId, fabricId: fab[n]!, name: `لون ${n}` })) as never);
  await db.insert(rolls).values([
    { id: roll[0]!, tenantId, colorId: col[0]!, rollNo: `P-${tenantId.slice(0, 4)}-0`, initialKg: "100", remainingKg: "63.25", pricePerKg: "2.5", currency: "USD", entryDate: "2026-07-05", pieces: 1, remainingPieces: 1 },
    { id: roll[1]!, tenantId, colorId: col[1]!, rollNo: `P-${tenantId.slice(0, 4)}-1`, initialKg: "80", remainingKg: "40.5", pricePerKg: "12000", currency: "SYP", entryDate: "2026-07-05", pieces: 1, remainingPieces: 1 },
  ] as never);
  for (const [n, i] of INVS.entries()) {
    const id = randomUUID();
    const subtotal = round2dp(i.lines.reduce((s, l) => s + Math.max(0, round2dp(l.qty * l.price - l.disc)), 0));
    await db.insert(invoices).values({
      id, tenantId, number: `PAR-${n}-${tenantId.slice(0, 4)}`, type: i.type, date: i.date,
      partyId: i.party, partyType: i.type === "sale" ? "customer" : "supplier", currency: i.ccy,
      exchangeRate: i.ccy === "USD" ? 1 : 13000, subtotal, discount: i.discount, tax: i.tax,
      shipping: i.shipping, total: totalOf(i), paid: i.paid, status: i.status,
    } as never);
    await db.insert(invoiceLines).values(
      i.lines.map((l) => ({
        id: randomUUID(), tenantId, invoiceId: id, fabricId: fab[l.fabric]!, colorId: col[l.fabric]!,
        rollId: roll[l.fabric]!, quantityKg: String(l.qty), pricePerKg: String(l.price),
        discountAmount: String(l.disc), lineTotal: String(Math.max(0, round2dp(l.qty * l.price - l.disc))),
      })) as never,
    );
  }
  for (const [n, r] of RETS.entries()) {
    const id = randomUUID();
    await db.insert(returns).values({
      id, tenantId, number: `PRT-${n}-${tenantId.slice(0, 4)}`, kind: r.kind, date: r.date,
      partyId: r.party, reason: "other", currency: r.ccy, status: r.status,
    } as never);
    await db.insert(returnLines).values(
      r.lines.map((l, k) => ({ id: randomUUID(), tenantId, returnId: id, rollId: roll[k % 2]!, quantityKg: String(l.qty), pricePerKg: String(l.price) })) as never,
    );
  }
  for (const [n, e] of EXPS.entries()) {
    await db.insert(expenses).values({
      id: randomUUID(), tenantId, number: `PEX-${n}-${tenantId.slice(0, 4)}`, category: "عام",
      description: "x", amount: e.amount, currency: e.ccy, date: e.date, method: "cash", status: e.status,
    } as never);
  }
});

describe.each([FROM, null])("report aggregates == old browser formulas (from=%s)", (from) => {
  const activeInv = (t: "sale" | "entry") =>
    INVS.filter((i) => i.status !== "cancelled" && i.type === t && inRange(i.date, from));

  it("sales / purchases totals, paid, remaining", async () => {
    for (const t of ["sale", "entry"] as const) {
      const got = await agg.invoiceTotalsByCurrency(db, tenantId, t, from);
      const xs = activeInv(t);
      expect(got.total).toEqual(group(xs, totalOf, (i) => i.ccy));
      expect(got.paid).toEqual(group(xs, (i) => i.paid, (i) => i.ccy));
      expect(got.remaining).toEqual(group(xs, (i) => Math.max(0, totalOf(i) - i.paid), (i) => i.ccy));
      expect(got.count).toBe(xs.length);
    }
  });

  it("returns by kind", async () => {
    for (const k of ["sale", "entry"] as const) {
      const got = await agg.returnTotalsByCurrency(db, tenantId, k, from);
      const xs = RETS.filter((r) => r.kind === k && r.status !== "cancelled" && inRange(r.date, from));
      expect(got.total).toEqual(group(xs, (r) => r.lines.reduce((s, l) => s + l.qty * l.price, 0), (r) => r.ccy));
      expect(got.count).toBe(xs.length);
    }
  });

  it("expenses", async () => {
    const got = await agg.expenseTotalsByCurrency(db, tenantId, from);
    const xs = EXPS.filter((e) => e.status !== "cancelled" && inRange(e.date, from));
    expect(got.total).toEqual(group(xs, (e) => e.amount, (e) => e.ccy));
  });

  it("top fabrics (kg rank, gross revenue by invoice currency)", async () => {
    const got = await agg.topFabrics(db, tenantId, from, 10);
    const map = new Map<string, { qty: number; revenueByCurrency: Record<string, number> }>();
    for (const i of activeInv("sale"))
      for (const l of i.lines) {
        const id = fab[l.fabric]!;
        const c = map.get(id) ?? { qty: 0, revenueByCurrency: {} };
        c.qty = round2dp(c.qty + l.qty);
        c.revenueByCurrency[i.ccy] = round2dp((c.revenueByCurrency[i.ccy] ?? 0) + l.qty * l.price);
        map.set(id, c);
      }
    const expected = [...map.entries()].sort((a, b) => b[1].qty - a[1].qty);
    expect(got.map((g) => [g.fabricId, { qty: g.qty, revenueByCurrency: g.revenueByCurrency }])).toEqual(expected);
  });

  it("top customers (both rankings)", async () => {
    const per = new Map<string, Record<string, number>>();
    for (const i of activeInv("sale")) {
      const p = per.get(i.party) ?? {};
      p[i.ccy] = round2dp((p[i.ccy] ?? 0) + totalOf(i));
      per.set(i.party, p);
    }
    const usdFirst = (x: Record<string, number>) => (x.USD ?? 0) * 1e9 + (x.SYP ?? 0) + (x.EUR ?? 0);
    const e1 = [...per.entries()].sort((a, b) => usdFirst(b[1]) - usdFirst(a[1]));
    const g1 = await agg.topCustomers(db, tenantId, from, 5, "usdFirst");
    expect(g1.map((g) => [g.partyId, g.revenueByCurrency])).toEqual(e1);
    const e2 = [...per.entries()].sort((a, b) => (b[1].SYP ?? 0) - (a[1].SYP ?? 0));
    const g2 = await agg.topCustomers(db, tenantId, from, 10, "syp");
    expect(g2.map((g) => [g.partyId, g.revenueByCurrency])).toEqual(e2);
  });
});

describe("inventory + paging", () => {
  it("inventory value per roll currency", async () => {
    const got = await agg.inventoryValue(db, tenantId);
    expect(got.value).toEqual({ USD: round2dp(63.25 * 2.5), SYP: round2dp(40.5 * 12000) });
    expect(got.totalKg).toBe(round2dp(63.25 + 40.5));
  });

  it("paged invoice rows cover every active row exactly once", async () => {
    const seen: string[] = [];
    for (let page = 0; page < 10; page++) {
      const r = await agg.pagedRows(db, tenantId, "net-sales", null, { page, limit: 1 });
      seen.push(...r!.rows.map((x) => String(x.id)));
      if ((page + 1) * 1 >= r!.total) break;
    }
    expect(seen).toHaveLength(INVS.filter((i) => i.type === "sale" && i.status !== "cancelled").length);
    expect(new Set(seen).size).toBe(seen.length);
  });
});
