/**
 * Two money-chain gaps from the forensic audit's adequacy matrix, on the real repositories
 * (engine-agnostic: runs on SQLite and PostgreSQL):
 *
 *  1. Concurrent partial receipts on ONE invoice — the matrix's "concurrent settlement race". Every
 *     receipt must land: invoice.paid = sum of receipts, and remaining = statement = party ledger,
 *     cash in = sum. A lost update (read paid, add, write) would keep only one receipt.
 *  2. One sale on a real DB — "balanced legs + stock decrement together": the persisted ledger legs
 *     balance in base currency, the roll loses exactly the sold kg, and a cancel restores both.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, and, sql } from "drizzle-orm";
import { round2dp } from "@erp/shared";
import { db } from "@/infrastructure/orm/drizzle.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import { parties } from "@/infrastructure/orm/schemas/party.table.js";
import { fabrics } from "@/infrastructure/orm/schemas/fabric.table.js";
import { colors } from "@/infrastructure/orm/schemas/color.table.js";
import { invoices } from "@/infrastructure/orm/schemas/invoice.table.js";
import { ledgerEntries } from "@/infrastructure/orm/schemas/ledger-entry.table.js";
import { PostgresInvoiceRepository } from "@/infrastructure/repositories/PostgresInvoiceRepository.js";
import { PostgresRollRepository } from "@/infrastructure/repositories/PostgresRollRepository.js";
import { PostgresVoucherRepository } from "@/infrastructure/repositories/PostgresVoucherRepository.js";
import { PostgresStatementRepository } from "@/infrastructure/repositories/PostgresStatementRepository.js";
import { getCashboxBalanceAsOf } from "@/infrastructure/repositories/cashboxBalanceHelper.js";
import type { TenantContext } from "@/domain/types/index.js";

const tenantId = randomUUID();
const customerId = randomUUID();
const supplierId = randomUUID();
const fabricId = randomUUID();
const colorId = randomUUID();
const ctx: TenantContext = { tenantId, userId: randomUUID(), userRole: "admin", userName: "chain-tester" };
const DAY = "2026-09-16";

const invoiceRepo = new PostgresInvoiceRepository(db);
const rollRepo = new PostgresRollRepository(db);
const voucherRepo = new PostgresVoucherRepository(db);
const statements = new PostgresStatementRepository(db);

async function sell(kg: number, pricePerKg: number) {
  const roll = await rollRepo.create(
    {
      colorId,
      rollNo: `R-${randomUUID().slice(0, 8)}`,
      initialKg: 50,
      remainingKg: 50,
      pieces: 1,
      pricePerKg: 4,
      currency: "USD",
      supplierId,
      entryDate: "2026-09-01",
    },
    ctx,
  );
  const invoice = await invoiceRepo.create(
    {
      type: "sale",
      date: DAY,
      partyId: customerId,
      partyType: "customer",
      currency: "USD",
      exchangeRate: 10_000,
      lines: [{ fabricId, colorId, rollId: roll.id, quantityKg: kg, pieces: 1, pricePerKg }],
    },
    ctx,
  );
  return { roll, invoice };
}

const receipt = (invoiceId: string, amount: number) =>
  voucherRepo.create(
    {
      kind: "receipt",
      date: DAY,
      partyId: customerId,
      partyKind: "customer",
      invoiceId,
      amount,
      currency: "USD",
      exchangeRate: 10_000,
      method: "cash",
    },
    ctx,
  );

async function partyLedgerUsd(): Promise<number> {
  const [row] = await db
    .select({
      net: sql<number>`COALESCE(SUM(${ledgerEntries.debit} - ${ledgerEntries.credit}), 0)`.mapWith(ledgerEntries.debit),
    })
    .from(ledgerEntries)
    .where(
      and(
        eq(ledgerEntries.tenantId, tenantId),
        eq(ledgerEntries.partyId, customerId),
        eq(ledgerEntries.currency, "USD"),
        eq(ledgerEntries.status, "active"),
      ),
    );
  return round2dp(Number(row?.net ?? 0));
}

const invoicePaid = async (id: string) => {
  const [row] = await db
    .select({ paid: invoices.paid, total: invoices.total, status: invoices.status })
    .from(invoices)
    .where(eq(invoices.id, id));
  return { paid: round2dp(Number(row.paid)), total: round2dp(Number(row.total)), status: row.status };
};

const cashUsd = async () => round2dp(await db.transaction((tx) => getCashboxBalanceAsOf(tx, ctx, "USD", DAY)));

describe("money chain integrity", () => {
  beforeAll(async () => {
    await db.execute(sql`select 1`);
    await db.insert(tenants).values({ id: tenantId, name: "Money Chain Tenant", slug: `chain-${tenantId.slice(0, 8)}` });
    await db.insert(parties).values([
      { id: customerId, tenantId, name: "Chain Customer", code: "CHAIN-C", kind: "customer", currency: "USD" },
      { id: supplierId, tenantId, name: "Chain Supplier", code: "CHAIN-S", kind: "supplier", currency: "USD" },
    ]);
    await db.insert(fabrics).values({ id: fabricId, tenantId, name: "Cotton", minStockKg: "0" });
    await db.insert(colors).values({ id: colorId, tenantId, fabricId, name: "White" });
  });

  it("concurrent partial receipts on one invoice all land — no lost update", async () => {
    const { invoice } = await sell(10, 10); // 100 USD
    expect((await invoicePaid(invoice.id)).total).toBe(100);
    const cashBefore = await cashUsd();

    // Five receipts submitted together: 10 + 15 + 5 + 20 + 12.5 = 62.5 (never more than the total).
    const amounts = [10, 15, 5, 20, 12.5];
    const results = await Promise.allSettled(amounts.map((a) => receipt(invoice.id, a)));
    const failed = results.filter((r) => r.status === "rejected") as PromiseRejectedResult[];
    expect(failed.map((f) => String(f.reason))).toEqual([]);

    const inv = await invoicePaid(invoice.id);
    expect(inv.paid).toBe(62.5);
    const remaining = round2dp(inv.total - inv.paid);
    expect(remaining).toBe(37.5);
    expect(await partyLedgerUsd()).toBe(remaining);
    const stmt = await statements.getStatement({ partyId: customerId, kind: "customer", currency: "USD" }, ctx);
    expect(round2dp(stmt.finalBalance)).toBe(remaining);
    expect(round2dp((await cashUsd()) - cashBefore)).toBe(62.5);
  });

  it("a sale balances its ledger legs and moves stock; a cancel restores both", async () => {
    const ledgerBefore = await partyLedgerUsd();
    const { roll, invoice } = await sell(7.5, 12); // 90 USD
    expect(Number((await rollRepo.findById(roll.id, ctx))?.remainingKg)).toBe(42.5);

    const legs = await db
      .select({ d: ledgerEntries.baseDebit, c: ledgerEntries.baseCredit, partyId: ledgerEntries.partyId, debit: ledgerEntries.debit })
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.tenantId, tenantId), eq(ledgerEntries.referenceId, invoice.id), eq(ledgerEntries.status, "active")));
    expect(legs.length).toBeGreaterThan(1);
    const baseDebit = round2dp(legs.reduce((s, l) => s + Number(l.d ?? 0), 0));
    const baseCredit = round2dp(legs.reduce((s, l) => s + Number(l.c ?? 0), 0));
    expect(baseDebit).toBe(baseCredit);
    expect(round2dp((await partyLedgerUsd()) - ledgerBefore)).toBe(90);

    const fresh = await invoiceRepo.findById(invoice.id, ctx);
    await invoiceRepo.cancel(invoice.id, ctx.userId, ctx, Number(fresh?.version ?? 1));
    expect((await invoicePaid(invoice.id)).status).toBe("cancelled");
    expect(Number((await rollRepo.findById(roll.id, ctx))?.remainingKg)).toBe(50);
    expect(await partyLedgerUsd()).toBe(ledgerBefore);
  });
});
