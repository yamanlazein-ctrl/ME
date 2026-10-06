/**
 * Year-end closing invariants.
 *
 * The two that matter most and are easiest to get wrong:
 *
 *  1. NO DOUBLE COUNT. The ledger is running (unbounded SUM), so a close must
 *     NOT post an "opening" entry carrying the prior balance — that would make
 *     a 4,500 debt read as 9,000. The carried balance belongs in a SNAPSHOT.
 *
 *  2. NO DESTRUCTION. Closing a year must leave every invoice, invoice line,
 *     ledger row, voucher and stock movement exactly where it was, still
 *     readable and printable.
 *
 * Plus: atomicity, a closed year rejecting writes, double-close rejection, and
 * per-currency cashbox carry-forward.
 *
 * Live-Postgres suite: DATABASE_URL unset → visible skip; DATABASE_URL set but
 * unreachable → HARD FAIL (never a vacuous pass).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/infrastructure/orm/drizzle.js";
import { runWithTenantContext } from "@/infrastructure/orm/tenant-context.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import { parties } from "@/infrastructure/orm/schemas/party.table.js";
import { fabrics } from "@/infrastructure/orm/schemas/fabric.table.js";
import { colors } from "@/infrastructure/orm/schemas/color.table.js";
import { rolls } from "@/infrastructure/orm/schemas/roll.table.js";
import { invoices } from "@/infrastructure/orm/schemas/invoice.table.js";
import { invoiceLines } from "@/infrastructure/orm/schemas/invoice-line.table.js";
import { vouchers } from "@/infrastructure/orm/schemas/voucher.table.js";
import { ledgerEntries } from "@/infrastructure/orm/schemas/ledger-entry.table.js";
import { stockMovements } from "@/infrastructure/orm/schemas/stock-movement.table.js";
import { inventoryCounts } from "@/infrastructure/orm/schemas/inventory-count.table.js";
import { financialYears } from "@/infrastructure/orm/schemas/financial-year.table.js";
import { yearlyPartySummaries } from "@/infrastructure/orm/schemas/yearly-party-summary.table.js";
import { cashboxSessions } from "@/infrastructure/orm/schemas/cashbox.table.js";
import { databaseReachable, skipUnlessDatabase } from "./_helpers/requireDatabase.js";
import {
  closeFinancialYear,
  reopenFinancialYear,
} from "@/infrastructure/repositories/financialYearRepository.js";
import {
  recordCount,
  postCountVariance,
} from "@/infrastructure/repositories/inventoryCountRepository.js";
import { assertYearOpen } from "@/infrastructure/repositories/dayLockHelper.js";
import { PostgresLedgerRepository } from "@/infrastructure/repositories/PostgresLedgerRepository.js";
import { recomputeCashboxBalanceAsOf } from "@/infrastructure/repositories/cashboxBalanceHelper.js";
import { BusinessRuleError, DayLockedError } from "@/domain/errors/index.js";
import type { TenantContext } from "@/domain/types/index.js";

const tenantId = randomUUID();
const customerId = randomUUID();
/** A second customer who is left OWED money — the debt that must survive. */
const debtorId = randomUUID();
const debtorInvoiceId = randomUUID();
const fabricId = randomUUID();
const colorId = randomUUID();
const rollId = randomUUID();
/** A second roll, so each variance test owns its own sheet. */
const rollId2 = randomUUID();
/** A third roll, for the "counted exactly → no movement" case. */
const rollId3 = randomUUID();
const invoiceId = randomUUID();
const voucherId = randomUUID();

/** Customer bills 4,500 and pays 4,500: the party nets to zero, the drawer to +4,500. */
const DEBT = 4500;
const CASH = 4500;
let reachable = false;

const ctx: TenantContext = {
  tenantId,
  userId: randomUUID(),
  userRole: "admin",
  userName: "closing-tester",
};

async function seed(): Promise<void> {
  await db.insert(tenants).values({
    id: tenantId,
    name: `close-${tenantId.slice(0, 8)}`,
    // `slug` is NOT NULL + unique on tenants, so the seed must supply it.
    slug: `close-${tenantId.slice(0, 8)}`,
  } as never);
  await db.insert(parties).values([
    { id: customerId, tenantId, kind: "customer", name: `C-${customerId.slice(0, 6)}`, openingBalance: 0 },
    { id: debtorId, tenantId, kind: "customer", name: `D-${debtorId.slice(0, 6)}`, openingBalance: 0 },
  ] as never);
  await db.insert(fabrics).values({ id: fabricId, tenantId, name: "قماش-اختبار" } as never);
  await db.insert(colors).values({ id: colorId, tenantId, fabricId, name: "أزرق", code: "B1" } as never);
  await db.insert(rolls).values([
    { id: rollId, tenantId, colorId, rollNo: 7001,
      initialKg: 100, remainingKg: 100, pricePerKg: 500, currency: "SYP",
      entryDate: "2026-01-05", status: "in_stock" },
    { id: rollId2, tenantId, colorId, rollNo: 7002,
      initialKg: 50, remainingKg: 50, pricePerKg: 400, currency: "SYP",
      entryDate: "2026-01-06", status: "in_stock" },
    { id: rollId3, tenantId, colorId, rollNo: 7003,
      initialKg: 30, remainingKg: 30, pricePerKg: 300, currency: "SYP",
      entryDate: "2026-01-07", status: "in_stock" },
  ] as never);
  await db.insert(invoices).values([
    { id: invoiceId, tenantId, number: "SAL-2026-1", type: "sale", date: "2026-03-01",
      partyId: customerId, partyType: "customer", currency: "SYP",
      subtotal: DEBT, total: DEBT, paid: 0, status: "active" },
    // Billed and NEVER paid — this debt is what must survive the close.
    { id: debtorInvoiceId, tenantId, number: "SAL-2026-2", type: "sale", date: "2026-04-10",
      partyId: debtorId, partyType: "customer", currency: "SYP",
      subtotal: DEBT, total: DEBT, paid: 0, status: "active" },
  ] as never);
  await db.insert(invoiceLines).values({
    tenantId, invoiceId, fabricId, colorId, rollId,
    quantityKg: 10, pricePerKg: 450, costPerKg: 500, amount: DEBT,
  } as never);
  await db.insert(vouchers).values({
    id: voucherId, tenantId, kind: "receipt", number: "RCP-1", date: "2026-03-02",
    partyId: customerId, partyKind: "customer", invoiceId, amount: CASH,
    currency: "SYP", method: "cash", status: "active",
  } as never);
  // A sale posts FOUR legs that balance as a set (see
  // invoice-ledger-legs-balance.test.ts): sales_invoice (Dr AR) +
  // sales_revenue (Cr) + inventory_asset (Dr) + cogs_expense (Cr). Seeding only
  // the party leg would be unrealistic and would (correctly) trip the close's
  // unbalanced-document check.
  const REVENUE = DEBT;
  const COGS = 5_000;
  await db.insert(ledgerEntries).values([
    // ── Invoice 1: billed AND paid in full. The party nets to zero. ──
    { tenantId, partyId: customerId, date: "2026-03-01", type: "sales_invoice",
      debit: DEBT, credit: 0, currency: "SYP", cashImpact: "none",
      referenceType: "sales_invoice", referenceId: invoiceId, referenceNumber: "SAL-2026-1",
      description: "فاتورة" },
    { tenantId, date: "2026-03-01", type: "sales_revenue",
      debit: 0, credit: REVENUE, currency: "SYP", cashImpact: "none",
      referenceType: "sales_invoice", referenceId: invoiceId, referenceNumber: "SAL-2026-1",
      description: "إيراد" },
    { tenantId, date: "2026-03-01", type: "inventory_asset",
      debit: COGS, credit: 0, currency: "SYP", cashImpact: "none",
      referenceType: "sales_invoice", referenceId: invoiceId, referenceNumber: "SAL-2026-1",
      description: "مخزون" },
    { tenantId, date: "2026-03-01", type: "cogs_expense",
      debit: 0, credit: COGS, currency: "SYP", cashImpact: "none",
      referenceType: "sales_invoice", referenceId: invoiceId, referenceNumber: "SAL-2026-1",
      description: "تكلفة" },
    // ── Invoice 2: billed, NEVER paid → 4,500 owed that must carry forward. ──
    { tenantId, partyId: debtorId, date: "2026-04-10", type: "sales_invoice",
      debit: DEBT, credit: 0, currency: "SYP", cashImpact: "none",
      referenceType: "sales_invoice", referenceId: debtorInvoiceId, referenceNumber: "SAL-2026-2",
      description: "فاتورة" },
    { tenantId, date: "2026-04-10", type: "sales_revenue",
      debit: 0, credit: REVENUE, currency: "SYP", cashImpact: "none",
      referenceType: "sales_invoice", referenceId: debtorInvoiceId, referenceNumber: "SAL-2026-2",
      description: "إيراد" },
    { tenantId, date: "2026-04-10", type: "inventory_asset",
      debit: COGS, credit: 0, currency: "SYP", cashImpact: "none",
      referenceType: "sales_invoice", referenceId: debtorInvoiceId, referenceNumber: "SAL-2026-2",
      description: "مخزون" },
    { tenantId, date: "2026-04-10", type: "cogs_expense",
      debit: 0, credit: COGS, currency: "SYP", cashImpact: "none",
      referenceType: "sales_invoice", referenceId: debtorInvoiceId, referenceNumber: "SAL-2026-2",
      description: "تكلفة" },
    // The receipt: party leg + cash leg, balanced as its own set.
    { tenantId, partyId: customerId, date: "2026-03-02", type: "receipt_in",
      debit: 0, credit: CASH, currency: "SYP", cashImpact: "none",
      referenceType: "receipt_in", referenceId: voucherId, referenceNumber: "RCP-1",
      description: "سند قبض" },
    { tenantId, date: "2026-03-02", type: "cash",
      debit: CASH, credit: 0, currency: "SYP", cashImpact: "in",
      referenceType: "receipt_in", referenceId: voucherId, referenceNumber: "RCP-1",
      description: "نقدية" },
  ] as never);
  await db.insert(cashboxSessions).values({
    tenantId, currency: "SYP", openingBalance: 0, openingDate: "2026-01-01",
  } as never);
}

beforeAll(async () => {
  reachable = await databaseReachable();
  if (!reachable) return;
  await runWithTenantContext({ tenantId }, seed);
});

async function cleanup(): Promise<void> {
  // `ledger_entries` is append-only by a trigger that RAISEs on DELETE, so the
  // teardown has to lift it for the duration and put it straight back. If this
  // ever fails, the trigger is restored in the finally — never left disabled.
  await db.execute(
    sql`DROP TRIGGER IF EXISTS trg_ledger_entries_append_only ON ledger_entries`,
  );
  try {
    // Reverse dependency order. Nothing here is a production code path.
    for (const stmt of [
      sql`DELETE FROM yearly_party_summaries WHERE tenant_id = ${tenantId}::uuid`,
      sql`DELETE FROM inventory_counts WHERE tenant_id = ${tenantId}::uuid`,
      sql`DELETE FROM audit_logs WHERE tenant_id = ${tenantId}::uuid`,
      sql`DELETE FROM ledger_entries WHERE tenant_id = ${tenantId}::uuid`,
      sql`DELETE FROM stock_movements WHERE tenant_id = ${tenantId}::uuid`,
      sql`DELETE FROM invoice_lines WHERE tenant_id = ${tenantId}::uuid`,
      sql`DELETE FROM vouchers WHERE tenant_id = ${tenantId}::uuid`,
      sql`DELETE FROM invoices WHERE tenant_id = ${tenantId}::uuid`,
      sql`DELETE FROM cashbox_daily_balances WHERE tenant_id = ${tenantId}::uuid`,
      sql`DELETE FROM cashbox_sessions WHERE tenant_id = ${tenantId}::uuid`,
      sql`DELETE FROM rolls WHERE tenant_id = ${tenantId}::uuid`,
      sql`DELETE FROM colors WHERE tenant_id = ${tenantId}::uuid`,
      sql`DELETE FROM fabrics WHERE tenant_id = ${tenantId}::uuid`,
      sql`DELETE FROM parties WHERE tenant_id = ${tenantId}::uuid`,
      sql`DELETE FROM financial_years WHERE tenant_id = ${tenantId}::uuid`,
      sql`DELETE FROM tenants WHERE id = ${tenantId}::uuid`,
    ]) {
      await db.execute(stmt);
    }
  } finally {
    await db.execute(sql`
      CREATE OR REPLACE TRIGGER trg_ledger_entries_append_only
      BEFORE UPDATE OR DELETE ON ledger_entries
      FOR EACH ROW EXECUTE FUNCTION fn_ledger_entries_append_only()`);
  }
}

afterAll(async () => {
  if (!reachable) return;
  await runWithTenantContext({ tenantId }, cleanup);
});

/** Count rows in a tenant table — the "nothing was destroyed" assertions. */
async function countOf(table: string): Promise<number> {
  // db.execute() resolves to a QueryResult ({ rows }), not a bare array.
  const res = (await db.execute(
    sql`SELECT count(*)::int AS n FROM ${sql.identifier(table)} WHERE tenant_id = ${tenantId}::uuid`,
  )) as unknown as { rows: Array<{ n: number }> };
  return Number(res.rows[0]?.n ?? 0);
}

const ledgerRepo = new PostgresLedgerRepository(db);

describe("year-end closing — no double count", () => {
  it("does NOT post an opening ledger row, so balances stay single-counted", async (t) => {
    skipUnlessDatabase(reachable, t.skip);
    await runWithTenantContext({ tenantId }, async () => {
      const before = await countOf("ledger_entries");
      await db.transaction((tx) => closeFinancialYear(tx, ctx, 2026, "اختبار"));

      // THE regression this feature must never ship: a close that adds an
      // `opening` leg would make the same money readable twice.
      expect(await countOf("ledger_entries")).toBe(before);

      // The party nets to zero (billed 4,500, paid 4,500) — once, not twice.
      const bal = await ledgerRepo.getBalance(customerId, ctx, "SYP");
      expect(bal.balance).toBe(0);
    });
  });

  it("carries an unpaid debt forward as a snapshot, never as a ledger entry", async (t) => {
    skipUnlessDatabase(reachable, t.skip);
    await runWithTenantContext({ tenantId }, async () => {
      // The debtor is owed 4,500 and paid nothing — the debt must be carried.
      const owed = await ledgerRepo.getBalance(debtorId, ctx, "SYP");
      expect(owed.balance).toBe(DEBT);

      const [snap] = await db
        .select()
        .from(yearlyPartySummaries)
        .where(
          and(
            eq(yearlyPartySummaries.tenantId, tenantId),
            eq(yearlyPartySummaries.year, 2026),
            eq(yearlyPartySummaries.partyId, debtorId),
            eq(yearlyPartySummaries.currency, "SYP"),
          ),
        )
        .limit(1);
      expect(snap).toBeDefined();
      // 2026 opened at 0 and closed still owed 4,500 → that IS the 2027 opening.
      expect(Number(snap!.openingBalance)).toBe(0);
      expect(Number(snap!.closingBalance)).toBe(DEBT);

      // Read back through the LIVE ledger: still exactly one debt of 4,500,
      // in 2027, with no second copy anywhere.
      expect((await ledgerRepo.getBalance(debtorId, ctx, "SYP")).balance).toBe(DEBT);
      expect(
        (await ledgerRepo.getBalanceByDate(debtorId, "2027-01-01", ctx, "SYP")).balance,
      ).toBe(DEBT);
    });
  });

  it("getBalanceByDate reads the carried balance exactly once", async (t) => {
    skipUnlessDatabase(reachable, t.skip);
    await runWithTenantContext({ tenantId }, async () => {
      expect((await ledgerRepo.getBalanceByDate(customerId, "2026-01-01", ctx, "SYP")).balance).toBe(0);
      expect((await ledgerRepo.getBalanceByDate(customerId, "2026-03-01", ctx, "SYP")).balance).toBe(DEBT);
      expect((await ledgerRepo.getBalanceByDate(customerId, "2026-12-31", ctx, "SYP")).balance).toBe(0);
      // The 2027 opening reading — carried forward, still exactly once.
      expect((await ledgerRepo.getBalanceByDate(customerId, "2027-01-01", ctx, "SYP")).balance).toBe(0);
    });
  });
});

describe("year-end closing — nothing is destroyed", () => {
  it("leaves every historical document in place after the close", async (t) => {
    skipUnlessDatabase(reachable, t.skip);
    await runWithTenantContext({ tenantId }, async () => {
      // The 2026 invoice must still be there, complete with its line, so it
      // can still be opened and printed after the year is closed.
      const [inv] = await db.select().from(invoices).where(eq(invoices.id, invoiceId));
      expect(inv).toBeDefined();
      expect(inv!.number).toBe("SAL-2026-1");

      const [line] = await db.select().from(invoiceLines).where(eq(invoiceLines.invoiceId, invoiceId));
      expect(line).toBeDefined();
      expect(Number(line!.quantityKg)).toBe(10);
      // The cost snapshot taken at sale time is untouched.
      expect(Number(line!.costPerKg)).toBe(500);

      expect(await countOf("vouchers")).toBe(1);
      // The roll itself is still on the shelf.
      const [roll] = await db.select().from(rolls).where(eq(rolls.id, rollId));
      expect(Number(roll!.remainingKg)).toBe(100);
    });
  });
});

describe("year-end closing — cashbox, per currency", () => {
  it("carries the drawer forward without counting it twice", async (t) => {
    skipUnlessDatabase(reachable, t.skip);
    await runWithTenantContext({ tenantId }, async () => {
      // One receipt of 4,500 landed in SYP. Recompute (opening + cash legs) is
      // the ground truth and is what a close SNAPSHOTS — never adds to.
      const closing = await recomputeCashboxBalanceAsOf(db, ctx, "SYP", "2026-12-31");
      expect(closing).toBe(CASH);

      // Reading 2027 from the same continuous recompute gives the same money
      // exactly once — proof no opening cash leg was invented.
      const opening2027 = await recomputeCashboxBalanceAsOf(db, ctx, "SYP", "2027-01-01");
      expect(opening2027).toBe(CASH);
    });
  });

  it("rejects a double close and a write into the closed year", async (t) => {
    skipUnlessDatabase(reachable, t.skip);
    await runWithTenantContext({ tenantId }, async () => {
      // Already closed above — closing again must fail loudly.
      await expect(
        db.transaction((tx) => closeFinancialYear(tx, ctx, 2026, "محاولة ثانية")),
      ).rejects.toThrow();

      // Every ordinary write path calls this guard.
      await expect(assertYearOpen(db, tenantId, "2026-06-01")).rejects.toThrow(DayLockedError);
      // …while a date in the new year is unaffected.
      await expect(assertYearOpen(db, tenantId, "2027-01-15")).resolves.toBeUndefined();
    });
  });
});

describe("year-end closing — atomicity", () => {
  it("rolls back everything when a later step fails", async (t) => {
    skipUnlessDatabase(reachable, t.skip);
    await runWithTenantContext({ tenantId }, async () => {
      // Reopen so the year is closable again, then close it inside a
      // transaction that is forced to abort AFTER the close ran.
      await db.transaction((tx) => reopenFinancialYear(tx, ctx, 2026, "reset for rollback test"));

      // Baseline: earlier tests already committed a close, so the assertion is
      // "this transaction added nothing", not "the table is empty".
      const snapshotsBefore = await db
        .select()
        .from(yearlyPartySummaries)
        .where(
          and(eq(yearlyPartySummaries.tenantId, tenantId), eq(yearlyPartySummaries.year, 2026)),
        );

      await expect(
        db.transaction(async (tx) => {
          await closeFinancialYear(tx, ctx, 2026, "سيُلغى");
          throw new Error("forced failure after the close");
        }),
      ).rejects.toThrow(/forced failure/);

      // The close's snapshots must be gone: no partial closing survives.
      const snaps = await db
        .select()
        .from(yearlyPartySummaries)
        .where(
          and(eq(yearlyPartySummaries.tenantId, tenantId), eq(yearlyPartySummaries.year, 2026)),
        );
      expect(snaps.length).toBe(snapshotsBefore.length);

      // And the year is back to open, not stuck half-closed.
      const [fy] = await db
        .select({ status: financialYears.status })
        .from(financialYears)
        .where(and(eq(financialYears.tenantId, tenantId), eq(financialYears.year, 2026)))
        .limit(1);
      expect(fy?.status).not.toBe("closed");
    });
  });

  it("reopen requires a reason and is refused on an open year", async (t) => {
    skipUnlessDatabase(reachable, t.skip);
    await runWithTenantContext({ tenantId }, async () => {
      await db.transaction((tx) => closeFinancialYear(tx, ctx, 2026, "for reopen test"));
      await expect(
        db.transaction((tx) => reopenFinancialYear(tx, ctx, 2026, "   ")),
      ).rejects.toThrow(BusinessRuleError);

      await db.transaction((tx) => reopenFinancialYear(tx, ctx, 2026, "تصحيح فاتورة مغلقة"));
      // Reopened → writes inside 2026 are accepted again.
      await expect(assertYearOpen(db, tenantId, "2026-06-01")).resolves.toBeUndefined();
      // A second reopen of an already-open year is refused.
      await expect(
        db.transaction((tx) => reopenFinancialYear(tx, ctx, 2026, "مرة أخرى")),
      ).rejects.toThrow(BusinessRuleError);
    });
  });
});

describe("inventory count — a variance is a document", () => {
  it("posts physical < book as a real stock movement + accounting entry", async (t) => {
    skipUnlessDatabase(reachable, t.skip);
    await runWithTenantContext({ tenantId }, async () => {
      // 92 counted vs 100 on the book → an 8 kg LOSS.
      const { diffKg } = await db.transaction((tx) => recordCount(tx, ctx, 2026, rollId, 92, null, "عجز"));
      expect(diffKg).toBe(-8);

      const [count] = await db
        .select()
        .from(inventoryCounts)
        .where(and(eq(inventoryCounts.tenantId, tenantId), eq(inventoryCounts.rollId, rollId)))
        .limit(1);
      expect(Number(count!.bookKg)).toBe(100);

      const posted = await db.transaction((tx) => postCountVariance(tx, ctx, count!.id));
      expect(posted.diffKg).toBe(-8);

      // The shelf moved…
      const [roll] = await db.select().from(rolls).where(eq(rolls.id, rollId));
      expect(Number(roll!.remainingKg)).toBe(92);

      // …and an append-only `adjustment` movement explains why.
      const [mv] = await db
        .select()
        .from(stockMovements)
        .where(
          and(
            eq(stockMovements.tenantId, tenantId),
            eq(stockMovements.rollId, rollId),
            eq(stockMovements.movementType, "adjustment"),
          ),
        )
        .limit(1);
      expect(mv).toBeDefined();
      expect(mv!.direction).toBe("out");
      expect(Number(mv!.balanceAfterKg)).toBe(92);

      // A non-cash accounting leg: the loss hits P&L, the drawer does not move.
      const [leg] = await db
        .select()
        .from(ledgerEntries)
        .where(
          and(
            eq(ledgerEntries.tenantId, tenantId),
            eq(ledgerEntries.referenceType, "inventory_count"),
          ),
        )
        .limit(1);
      expect(leg).toBeDefined();
      expect(leg!.cashImpact).toBe("none");
      // 8 kg × 500 SYP cost = 4,000 written off.
      expect(Number(leg!.debit)).toBe(4000);

      // Re-posting is refused — `status` is the idempotency marker.
      await expect(
        db.transaction((tx) => postCountVariance(tx, ctx, count!.id)),
      ).rejects.toThrow(BusinessRuleError);
    });
  });

  it("accepts physical > book as a gain, and an exact count as no movement", async (t) => {
    skipUnlessDatabase(reachable, t.skip);
    await runWithTenantContext({ tenantId }, async () => {
      // Its own roll: a posted variance must not be re-countable (that guard is
      // the thing that stops a settled document being rewritten).
      const { diffKg } = await db.transaction((tx) => recordCount(tx, ctx, 2026, rollId2, 55, null, "زيادة"));
      // 55 counted vs 50 on the book → +5 kg GAIN.
      expect(diffKg).toBe(5);
      const [count] = await db
        .select()
        .from(inventoryCounts)
        .where(
          and(eq(inventoryCounts.tenantId, tenantId), eq(inventoryCounts.rollId, rollId2)),
        )
        .limit(1);
      await db.transaction((tx) => postCountVariance(tx, ctx, count!.id));

      const [mv] = await db
        .select()
        .from(stockMovements)
        .where(
          and(
            eq(stockMovements.tenantId, tenantId),
            eq(stockMovements.rollId, rollId2),
            eq(stockMovements.movementType, "adjustment"),
          ),
        )
        .limit(1);
      expect(mv!.direction).toBe("in");
      expect(Number(mv!.balanceAfterKg)).toBe(55);

      // A roll counted EXACTLY settles with NO stock movement. Its own roll
      // again: a posted line is deliberately not re-countable.
      const exact = await db.transaction((tx) => recordCount(tx, ctx, 2026, rollId3, 30, null, null));
      expect(exact.diffKg).toBe(0);
      const [same] = await db
        .select()
        .from(inventoryCounts)
        .where(
          and(eq(inventoryCounts.tenantId, tenantId), eq(inventoryCounts.rollId, rollId3)),
        )
        .limit(1);
      const result = await db.transaction((tx) => postCountVariance(tx, ctx, same!.id));
      expect(result.movementId).toBeNull();
      expect(result.diffKg).toBe(0);
    });
  });

  it("refuses to touch a closed year", async (t) => {
    skipUnlessDatabase(reachable, t.skip);
    await runWithTenantContext({ tenantId }, async () => {
      await db.transaction((tx) => closeFinancialYear(tx, ctx, 2026, "seal"));
      await expect(
        db.transaction((tx) => recordCount(tx, ctx, 2026, rollId, 10, null, null)),
      ).rejects.toThrow(/مقفلة/);
    });
  });
});