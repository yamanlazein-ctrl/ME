/**
 * Cross-currency settlement must reconcile invoice / statement / ledger / cashbox
 * at the voucher's own frozen FX — never a later rate, never raw voucher amounts
 * mixed into the invoice currency.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, and, sql } from "drizzle-orm";
import {
  convertForSettlement,
  computeBaseEquivalent,
  round2dp,
} from "@erp/shared";
import { db } from "@/infrastructure/orm/drizzle.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import { parties } from "@/infrastructure/orm/schemas/party.table.js";
import { invoices } from "@/infrastructure/orm/schemas/invoice.table.js";
import { vouchers } from "@/infrastructure/orm/schemas/voucher.table.js";
import { ledgerEntries } from "@/infrastructure/orm/schemas/ledger-entry.table.js";
import { PostgresVoucherRepository } from "@/infrastructure/repositories/PostgresVoucherRepository.js";
import { PostgresStatementRepository } from "@/infrastructure/repositories/PostgresStatementRepository.js";
import { PostgresProfitRepository } from "@/infrastructure/repositories/PostgresProfitRepository.js";
import { getCashboxBalanceAsOf } from "@/infrastructure/repositories/cashboxBalanceHelper.js";
import type { TenantContext } from "@/domain/types/index.js";

describe("convertForSettlement — exact stored units", () => {
  it("USD receipt at 10,000 SYP/USD clears 1,000,000 SYP with no leftover lira", () => {
    const settled = convertForSettlement(100, "USD", "SYP", 10_000);
    expect(settled).toBe(1_000_000);
    expect(computeBaseEquivalent(100, "USD", 1)).toBe(100);
    expect(computeBaseEquivalent(1_000_000, "SYP", 10_000)).toBe(100);
  });

  it("SYP receipt at 10,000 SYP/USD clears 100 USD exactly", () => {
    const settled = convertForSettlement(1_000_000, "SYP", "USD", 10_000);
    expect(settled).toBe(100);
  });

  it("two different settlement rates produce two different SYP equivalents for the same USD cash", () => {
    expect(convertForSettlement(100, "USD", "SYP", 10_000)).toBe(1_000_000);
    expect(convertForSettlement(100, "USD", "SYP", 12_000)).toBe(1_200_000);
  });

  it("same-currency settlement does not use a rate", () => {
    expect(convertForSettlement(1_000_000, "SYP", "SYP", 99_999)).toBe(1_000_000);
    expect(convertForSettlement(100, "USD", "USD", 10_000)).toBe(100);
  });
});

const tenantId = randomUUID();
const customerId = randomUUID();
const supplierId = randomUUID();
const ctx: TenantContext = {
  tenantId,
  userId: randomUUID(),
  userRole: "admin",
  userName: "fx-tester",
};

async function insertSale(opts: {
  id?: string;
  number: string;
  total: number;
  currency: string;
  exchangeRate: number;
  partyId?: string;
  type?: "sale" | "entry";
  partyType?: "customer" | "supplier";
}) {
  const id = opts.id ?? randomUUID();
  const partyId = opts.partyId ?? customerId;
  const type = opts.type ?? "sale";
  const base = computeBaseEquivalent(opts.total, opts.currency, opts.exchangeRate);
  await db.insert(invoices).values({
    id,
    tenantId,
    number: opts.number,
    type,
    date: "2026-09-16",
    partyId,
    partyType: opts.partyType ?? "customer",
    currency: opts.currency,
    subtotal: opts.total,
    total: opts.total,
    paid: 0,
    exchangeRate: opts.exchangeRate,
    baseTotal: base,
  });
  const isSale = type === "sale";
  await db.insert(ledgerEntries).values([
    {
      tenantId,
      partyId,
      date: "2026-09-16",
      type: isSale ? "sales_invoice" : "purchase_invoice",
      debit: isSale ? opts.total : 0,
      credit: isSale ? 0 : opts.total,
      currency: opts.currency,
      exchangeRate: opts.exchangeRate,
      baseDebit: isSale ? base : 0,
      baseCredit: isSale ? 0 : base,
      cashImpact: "none",
      referenceType: isSale ? "sales_invoice" : "purchase_invoice",
      referenceId: id,
      referenceNumber: opts.number,
      description: opts.number,
      createdBy: ctx.userId,
    },
    {
      tenantId,
      partyId: null,
      date: "2026-09-16",
      type: isSale ? "sales_revenue" : "inventory_asset",
      debit: isSale ? 0 : opts.total,
      credit: isSale ? opts.total : 0,
      currency: opts.currency,
      exchangeRate: opts.exchangeRate,
      baseDebit: isSale ? 0 : base,
      baseCredit: isSale ? base : 0,
      cashImpact: "none",
      referenceType: isSale ? "sales_invoice" : "purchase_invoice",
      referenceId: id,
      referenceNumber: opts.number,
      description: opts.number,
      createdBy: ctx.userId,
    },
  ]);
  return id;
}

describe("cross-currency voucher settlement (DB)", () => {
  beforeAll(async () => {
    await db.execute(sql`select 1`);
    await db.insert(tenants).values({
      id: tenantId,
      name: "FX Settlement Tenant",
      slug: `fxs-${tenantId.slice(0, 8)}`,
    });
    await db.insert(parties).values([
      {
        id: customerId,
        tenantId,
        name: "FX Customer",
        code: "FXC-1",
        kind: "customer",
        currency: "SYP",
      },
      {
        id: supplierId,
        tenantId,
        name: "FX Supplier",
        code: "FXS-1",
        kind: "supplier",
        currency: "SYP",
      },
    ]);
  });

  it("SYP invoice → USD receipt at settlement FX 10,000: paid/statement/ledger/cashbox/debts match", async () => {
    const repo = new PostgresVoucherRepository(db);
    const statements = new PostgresStatementRepository(db);
    const profit = new PostgresProfitRepository(db);
    const invId = await insertSale({
      number: "INV-FX-SYP-1",
      total: 1_000_000,
      currency: "SYP",
      exchangeRate: 10_000,
    });

    const v = await repo.create(
      {
        kind: "receipt",
        date: "2026-09-16",
        partyId: customerId,
        partyKind: "customer",
        invoiceId: invId,
        amount: 100,
        currency: "USD",
        exchangeRate: 10_000,
        method: "cash",
      },
      ctx,
    );

    expect(v.amount).toBe(100);
    expect(v.exchangeRate).toBe(10_000);
    expect(v.baseAmount).toBe(100);

    const [inv] = await db
      .select({ paid: invoices.paid, total: invoices.total })
      .from(invoices)
      .where(eq(invoices.id, invId));
    expect(Number(inv.total)).toBe(1_000_000);
    expect(Number(inv.paid)).toBe(1_000_000);

    const stmtSyp = await statements.getStatement(
      { partyId: customerId, kind: "customer", currency: "SYP" },
      ctx,
    );
    expect(stmtSyp.finalBalance).toBe(0);

    const [bal] = await db
      .select({
        debit: sql<number>`COALESCE(SUM(${ledgerEntries.baseDebit}), 0)`,
        credit: sql<number>`COALESCE(SUM(${ledgerEntries.baseCredit}), 0)`,
      })
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.referenceId, v.id),
          eq(ledgerEntries.tenantId, tenantId),
          eq(ledgerEntries.status, "active"),
        ),
      );
    expect(round2dp(Number(bal.debit))).toBe(round2dp(Number(bal.credit)));

    const usdCash = await db.transaction((tx) =>
      getCashboxBalanceAsOf(tx, ctx, "USD", "2026-09-16"),
    );
    const sypCash = await db.transaction((tx) =>
      getCashboxBalanceAsOf(tx, ctx, "SYP", "2026-09-16"),
    );
    expect(usdCash).toBe(100);
    expect(sypCash).toBe(0);

    const debts = await profit.getSummary({ fromDate: "2026-09-16", toDate: "2026-09-16" }, ctx);
    expect(debts.totalReceivables.find((d) => d.invoiceId === invId)).toBeUndefined();
  });

  it("USD invoice → SYP receipt at a different settlement FX than a sibling USD invoice", async () => {
    const repo = new PostgresVoucherRepository(db);
    const statements = new PostgresStatementRepository(db);
    const profit = new PostgresProfitRepository(db);

    const invA = await insertSale({
      number: "INV-FX-USD-A",
      total: 100,
      currency: "USD",
      exchangeRate: 10_000,
    });
    const invB = await insertSale({
      number: "INV-FX-USD-B",
      total: 50,
      currency: "USD",
      exchangeRate: 12_000,
    });

    const recA = await repo.create(
      {
        kind: "receipt",
        date: "2026-09-16",
        partyId: customerId,
        partyKind: "customer",
        invoiceId: invA,
        amount: 100,
        currency: "USD",
        exchangeRate: 10_000,
        method: "cash",
      },
      ctx,
    );
    expect(recA.amount).toBe(100);

    const recB = await repo.create(
      {
        kind: "receipt",
        date: "2026-09-16",
        partyId: customerId,
        partyKind: "customer",
        invoiceId: invB,
        amount: 600_000,
        currency: "SYP",
        exchangeRate: 12_000,
        method: "cash",
      },
      ctx,
    );
    expect(convertForSettlement(600_000, "SYP", "USD", 12_000)).toBe(50);
    expect(Number(recB.exchangeRate)).toBe(12_000);
    expect(Number(recB.baseAmount)).toBe(50);

    const rows = await db
      .select({ id: invoices.id, paid: invoices.paid, total: invoices.total })
      .from(invoices)
      .where(and(eq(invoices.tenantId, tenantId), sql`${invoices.number} like 'INV-FX-USD-%'`));
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(Number(byId[invA].paid)).toBe(100);
    expect(Number(byId[invB].paid)).toBe(50);

    const stmtUsd = await statements.getStatement(
      { partyId: customerId, kind: "customer", currency: "USD" },
      ctx,
    );
    // Two USD invoices 100+50 fully settled (plus any earlier USD AR from this tenant = 0).
    expect(stmtUsd.finalBalance).toBe(0);

    const debts = await profit.getSummary({ fromDate: "2026-09-16", toDate: "2026-09-16" }, ctx);
    expect(debts.totalReceivables.find((d) => d.invoiceId === invA)).toBeUndefined();
    expect(debts.totalReceivables.find((d) => d.invoiceId === invB)).toBeUndefined();

    const [voucherRow] = await db.select().from(vouchers).where(eq(vouchers.id, recB.id));
    expect(Number(voucherRow.exchangeRate)).toBe(12_000);

    const cancelled = await repo.cancel(recB.id, ctx.userId, ctx, recB.version);
    expect(cancelled.status).toBe("cancelled");
    const [after] = await db.select({ paid: invoices.paid }).from(invoices).where(eq(invoices.id, invB));
    expect(Number(after.paid)).toBe(0);

    const debtsAfter = await profit.getSummary(
      { fromDate: "2026-09-16", toDate: "2026-09-16" },
      ctx,
    );
    const openB = debtsAfter.totalReceivables.find((d) => d.invoiceId === invB);
    expect(openB?.remaining).toBe(50);
    expect(openB?.paid).toBe(0);
  });

  it("SYP invoice at FX 8,000 settled with 100 USD at FX 10,000 posts explained FX difference and zeros SYP AR", async () => {
    const repo = new PostgresVoucherRepository(db);
    const statements = new PostgresStatementRepository(db);
    const invId = await insertSale({
      number: "INV-FX-SYP-2",
      total: 1_000_000,
      currency: "SYP",
      exchangeRate: 8_000,
    });

    const v = await repo.create(
      {
        kind: "receipt",
        date: "2026-09-16",
        partyId: customerId,
        partyKind: "customer",
        invoiceId: invId,
        amount: 100,
        currency: "USD",
        exchangeRate: 10_000,
        method: "cash",
      },
      ctx,
    );

    const [inv] = await db.select({ paid: invoices.paid }).from(invoices).where(eq(invoices.id, invId));
    expect(Number(inv.paid)).toBe(1_000_000);

    const stmt = await statements.getStatement(
      { partyId: customerId, kind: "customer", currency: "SYP" },
      ctx,
    );
    expect(stmt.finalBalance).toBe(0);

    const fxLegs = await db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.referenceId, v.id),
          eq(ledgerEntries.tenantId, tenantId),
          sql`${ledgerEntries.type} in ('fx_gain','fx_loss')`,
        ),
      );
    // Party AR was booked 1,000,000/8000 = 125 USD; cash is 100 USD → 25 USD loss.
    expect(fxLegs).toHaveLength(1);
    expect(fxLegs[0].type).toBe("fx_loss");
    expect(Number(fxLegs[0].debit)).toBe(25);
    expect(fxLegs[0].currency).toBe("USD");

    const [bal] = await db
      .select({
        debit: sql<number>`COALESCE(SUM(${ledgerEntries.baseDebit}), 0)`,
        credit: sql<number>`COALESCE(SUM(${ledgerEntries.baseCredit}), 0)`,
      })
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.referenceId, v.id),
          eq(ledgerEntries.tenantId, tenantId),
          eq(ledgerEntries.status, "active"),
        ),
      );
    expect(round2dp(Number(bal.debit))).toBe(round2dp(Number(bal.credit)));
  });

  it("USD entry invoice paid with SYP uses invoices.paid (not raw voucher sum) for payables", async () => {
    const repo = new PostgresVoucherRepository(db);
    const profit = new PostgresProfitRepository(db);
    const invId = await insertSale({
      number: "ENT-FX-USD-1",
      total: 40,
      currency: "USD",
      exchangeRate: 10_000,
      partyId: supplierId,
      type: "entry",
      partyType: "supplier",
    });

    // Fund SYP cashbox so the payment guard can pass.
    await repo.create(
      {
        kind: "receipt",
        date: "2026-09-16",
        partyId: customerId,
        partyKind: "customer",
        amount: 400_000,
        currency: "SYP",
        exchangeRate: 10_000,
        method: "cash",
      },
      ctx,
    );

    await repo.create(
      {
        kind: "payment",
        date: "2026-09-16",
        partyId: supplierId,
        partyKind: "supplier",
        invoiceId: invId,
        amount: 400_000,
        currency: "SYP",
        exchangeRate: 10_000,
        method: "cash",
      },
      ctx,
    );

    const [inv] = await db.select({ paid: invoices.paid }).from(invoices).where(eq(invoices.id, invId));
    expect(Number(inv.paid)).toBe(40);

    const debts = await profit.getSummary({ fromDate: "2026-09-16", toDate: "2026-09-16" }, ctx);
    expect(debts.totalPayables.find((d) => d.invoiceId === invId)).toBeUndefined();
  });
});
