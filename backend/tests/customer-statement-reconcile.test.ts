/**
 * Customer statement must reconcile with invoices.paid, remaining, returns,
 * vouchers, cancellations, and the party ledger — using the real invoice /
 * voucher / return / statement repositories. Historical FX stays frozen.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, and, sql } from "drizzle-orm";
import { convertForSettlement, computeBaseEquivalent, round2dp } from "@erp/shared";
import { db } from "@/infrastructure/orm/drizzle.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import { parties } from "@/infrastructure/orm/schemas/party.table.js";
import { fabrics } from "@/infrastructure/orm/schemas/fabric.table.js";
import { colors } from "@/infrastructure/orm/schemas/color.table.js";
import { invoices } from "@/infrastructure/orm/schemas/invoice.table.js";
import { invoiceLines } from "@/infrastructure/orm/schemas/invoice-line.table.js";
import { ledgerEntries } from "@/infrastructure/orm/schemas/ledger-entry.table.js";
import { vouchers } from "@/infrastructure/orm/schemas/voucher.table.js";
import { returnLines } from "@/infrastructure/orm/schemas/return-line.table.js";
import { returns } from "@/infrastructure/orm/schemas/return.table.js";
import { PostgresInvoiceRepository } from "@/infrastructure/repositories/PostgresInvoiceRepository.js";
import { PostgresRollRepository } from "@/infrastructure/repositories/PostgresRollRepository.js";
import { PostgresVoucherRepository } from "@/infrastructure/repositories/PostgresVoucherRepository.js";
import { PostgresStatementRepository } from "@/infrastructure/repositories/PostgresStatementRepository.js";
import { PostgresReturnRepository } from "@/infrastructure/repositories/PostgresReturnRepository.js";
import { getCashboxBalanceAsOf } from "@/infrastructure/repositories/cashboxBalanceHelper.js";
import type { TenantContext } from "@/domain/types/index.js";

const tenantId = randomUUID();
const customerId = randomUUID();
const supplierId = randomUUID();
const fabricId = randomUUID();
const colorId = randomUUID();
const ctx: TenantContext = {
  tenantId,
  userId: randomUUID(),
  userRole: "admin",
  userName: "stmt-tester",
};

const invoiceRepo = new PostgresInvoiceRepository(db);
const rollRepo = new PostgresRollRepository(db);
const voucherRepo = new PostgresVoucherRepository(db);
const statements = new PostgresStatementRepository(db);
const returnRepo = new PostgresReturnRepository(db);

type Expected = {
  syp: { total: number; paid: number; returns: number; remaining: number; ledger: number; statement: number };
  usd: { total: number; paid: number; returns: number; remaining: number; ledger: number; statement: number };
  cashUsd: number;
  cashSyp: number;
};

async function independentExpected(): Promise<Expected> {
  const invRows = await db
    .select({
      id: invoices.id,
      currency: invoices.currency,
      total: invoices.total,
      paid: invoices.paid,
      status: invoices.status,
    })
    .from(invoices)
    .where(and(eq(invoices.tenantId, tenantId), eq(invoices.partyId, customerId)));

  const retRows = await db
    .select({
      invoiceId: returns.originalInvoiceId,
      amount: sql<number>`COALESCE(SUM(${returnLines.quantityKg} * ${returnLines.pricePerKg}), 0)`,
    })
    .from(returns)
    .innerJoin(returnLines, eq(returnLines.returnId, returns.id))
    .where(
      and(
        eq(returns.tenantId, tenantId),
        eq(returns.status, "active"),
        eq(returns.kind, "sale"),
      ),
    )
    .groupBy(returns.originalInvoiceId);
  const retByInv = new Map(retRows.map((r) => [r.invoiceId, Number(r.amount)]));

  const bucket = (ccy: string) => {
    let total = 0;
    let paid = 0;
    let ret = 0;
    for (const inv of invRows) {
      if (inv.status !== "active" || inv.currency !== ccy) continue;
      total += Number(inv.total);
      paid += Number(inv.paid);
      ret += retByInv.get(inv.id) ?? 0;
    }
    return { total: round2dp(total), paid: round2dp(paid), returns: round2dp(ret), remaining: round2dp(total - paid - ret) };
  };

  const ledgerOf = async (ccy: string) => {
    const [row] = await db
      .select({
        net: sql<number>`COALESCE(SUM(${ledgerEntries.debit} - ${ledgerEntries.credit}), 0)`,
      })
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.tenantId, tenantId),
          eq(ledgerEntries.partyId, customerId),
          eq(ledgerEntries.currency, ccy),
          eq(ledgerEntries.status, "active"),
        ),
      );
    return round2dp(Number(row?.net ?? 0));
  };

  const stmtSyp = await statements.getStatement(
    { partyId: customerId, kind: "customer", currency: "SYP" },
    ctx,
  );
  const stmtUsd = await statements.getStatement(
    { partyId: customerId, kind: "customer", currency: "USD" },
    ctx,
  );
  const cashUsd = await db.transaction((tx) => getCashboxBalanceAsOf(tx, ctx, "USD", "2026-09-16"));
  const cashSyp = await db.transaction((tx) => getCashboxBalanceAsOf(tx, ctx, "SYP", "2026-09-16"));

  const syp = bucket("SYP");
  const usd = bucket("USD");
  return {
    syp: { ...syp, ledger: await ledgerOf("SYP"), statement: round2dp(stmtSyp.finalBalance) },
    usd: { ...usd, ledger: await ledgerOf("USD"), statement: round2dp(stmtUsd.finalBalance) },
    cashUsd: round2dp(cashUsd),
    cashSyp: round2dp(cashSyp),
  };
}

function expectReconciled(got: Expected) {
  expect(got.syp.statement).toBe(got.syp.ledger);
  expect(got.syp.statement).toBe(got.syp.remaining);
  expect(got.usd.statement).toBe(got.usd.ledger);
  expect(got.usd.statement).toBe(got.usd.remaining);
}

async function sell(opts: {
  kg: number;
  price: number;
  currency: "SYP" | "USD";
  exchangeRate: number;
  date?: string;
}) {
  const roll = await rollRepo.create(
    {
      colorId,
      rollNo: `R-${randomUUID().slice(0, 8)}`,
      initialKg: opts.kg,
      remainingKg: opts.kg,
      pieces: 1,
      pricePerKg: Math.max(1, round2dp(opts.price * 0.4)),
      currency: opts.currency,
      supplierId,
      entryDate: opts.date ?? "2026-09-01",
    },
    ctx,
  );
  return invoiceRepo.create(
    {
      type: "sale",
      date: opts.date ?? "2026-09-16",
      partyId: customerId,
      partyType: "customer",
      currency: opts.currency,
      exchangeRate: opts.exchangeRate,
      lines: [
        {
          fabricId,
          colorId,
          rollId: roll.id,
          quantityKg: opts.kg,
          pieces: 1,
          pricePerKg: opts.price,
        },
      ],
    },
    ctx,
  );
}

describe("customer statement reconciliation (10 invoices)", () => {
  beforeAll(async () => {
    await db.execute(sql`select 1`);
    await db.insert(tenants).values({
      id: tenantId,
      name: "Statement Reconcile Tenant",
      slug: `stmt-${tenantId.slice(0, 8)}`,
    });
    await db.insert(parties).values([
      {
        id: customerId,
        tenantId,
        name: "Statement Customer",
        code: "STMT-C",
        kind: "customer",
        currency: "SYP",
      },
      {
        id: supplierId,
        tenantId,
        name: "Statement Supplier",
        code: "STMT-S",
        kind: "supplier",
        currency: "USD",
      },
    ]);
    await db.insert(fabrics).values({ id: fabricId, tenantId, name: "Cotton", minStockKg: "0" });
    await db.insert(colors).values({ id: colorId, tenantId, fabricId, name: "White" });
  });

  it("reconciles statement after create, receipts, edit, cancel, return, and FX freeze", async () => {
    const created = [];
    created.push(await sell({ kg: 10, price: 20_000, currency: "SYP", exchangeRate: 10_000 })); // 200,000
    created.push(await sell({ kg: 5, price: 30_000, currency: "SYP", exchangeRate: 10_000 })); // 150,000
    created.push(await sell({ kg: 8, price: 12_500, currency: "SYP", exchangeRate: 10_000 })); // 100,000  edit later
    created.push(await sell({ kg: 4, price: 25_000, currency: "SYP", exchangeRate: 11_000 })); // 100,000  cancel later
    created.push(await sell({ kg: 20, price: 10_000, currency: "SYP", exchangeRate: 10_000 })); // 200,000  return later
    created.push(await sell({ kg: 2, price: 50_000, currency: "SYP", exchangeRate: 9_000 })); // 100,000
    created.push(await sell({ kg: 10, price: 10, currency: "USD", exchangeRate: 10_000 })); // 100 USD
    created.push(await sell({ kg: 5, price: 10, currency: "USD", exchangeRate: 12_000 })); // 50 USD  SYP settlement
    created.push(await sell({ kg: 4, price: 25, currency: "USD", exchangeRate: 11_000 })); // 100 USD
    created.push(await sell({ kg: 10, price: 100_000, currency: "SYP", exchangeRate: 8_000 })); // 1,000,000 old conversion

    expect(created).toHaveLength(10);
    let snap = await independentExpected();
    expect(snap.syp.total).toBe(1_850_000);
    expect(snap.usd.total).toBe(250);
    expectReconciled(snap);
    expect(snap.cashUsd).toBe(0);
    expect(snap.cashSyp).toBe(0);

    // Receipts / settlements
    await voucherRepo.create(
      {
        kind: "receipt",
        date: "2026-09-16",
        partyId: customerId,
        partyKind: "customer",
        invoiceId: created[0].id,
        amount: 200_000,
        currency: "SYP",
        exchangeRate: 10_000,
        method: "cash",
      },
      ctx,
    );
    await voucherRepo.create(
      {
        kind: "receipt",
        date: "2026-09-16",
        partyId: customerId,
        partyKind: "customer",
        invoiceId: created[1].id,
        amount: 50_000,
        currency: "SYP",
        exchangeRate: 10_000,
        method: "cash",
      },
      ctx,
    );
    await voucherRepo.create(
      {
        kind: "receipt",
        date: "2026-09-16",
        partyId: customerId,
        partyKind: "customer",
        invoiceId: created[6].id,
        amount: 100,
        currency: "USD",
        exchangeRate: 10_000,
        method: "cash",
      },
      ctx,
    );
    // USD invoice → SYP settlement at THIS voucher's rate (12,000), not a later rate
    expect(convertForSettlement(600_000, "SYP", "USD", 12_000)).toBe(50);
    await voucherRepo.create(
      {
        kind: "receipt",
        date: "2026-09-16",
        partyId: customerId,
        partyKind: "customer",
        invoiceId: created[7].id,
        amount: 600_000,
        currency: "SYP",
        exchangeRate: 12_000,
        method: "cash",
      },
      ctx,
    );
    // Old conversion case: SYP invoice @ 8,000 settled with 100 USD @ 10,000
    await voucherRepo.create(
      {
        kind: "receipt",
        date: "2026-09-16",
        partyId: customerId,
        partyKind: "customer",
        invoiceId: created[9].id,
        amount: 100,
        currency: "USD",
        exchangeRate: 10_000,
        method: "cash",
      },
      ctx,
    );

    snap = await independentExpected();
    expect(Number((await db.select({ paid: invoices.paid }).from(invoices).where(eq(invoices.id, created[0].id)))[0].paid)).toBe(200_000);
    expect(Number((await db.select({ paid: invoices.paid }).from(invoices).where(eq(invoices.id, created[1].id)))[0].paid)).toBe(50_000);
    expect(Number((await db.select({ paid: invoices.paid }).from(invoices).where(eq(invoices.id, created[6].id)))[0].paid)).toBe(100);
    expect(Number((await db.select({ paid: invoices.paid }).from(invoices).where(eq(invoices.id, created[7].id)))[0].paid)).toBe(50);
    expect(Number((await db.select({ paid: invoices.paid }).from(invoices).where(eq(invoices.id, created[9].id)))[0].paid)).toBe(1_000_000);
    expectReconciled(snap);
    expect(snap.cashUsd).toBe(200);
    expect(snap.cashSyp).toBe(850_000);

    // Edit an old unpaid SYP invoice (qty 8 → 4) — FX must stay 10,000
    const [line3] = await db
      .select()
      .from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, created[2].id));
    // Historical FX is frozen: a new rate on edit is rejected.
    await expect(
      invoiceRepo.update(
        created[2].id,
        {
          date: created[2].date,
          exchangeRate: 99_999,
          lines: [
            {
              fabricId: line3.fabricId,
              colorId: line3.colorId,
              rollId: line3.rollId,
              quantityKg: 4,
              pieces: 1,
              pricePerKg: Number(line3.pricePerKg),
            },
          ],
        },
        ctx,
        created[2].version,
      ),
    ).rejects.toThrow();

    const edited = await invoiceRepo.update(
      created[2].id,
      {
        date: created[2].date,
        lines: [
          {
            fabricId: line3.fabricId,
            colorId: line3.colorId,
            rollId: line3.rollId,
            quantityKg: 4,
            pieces: 1,
            pricePerKg: Number(line3.pricePerKg),
          },
        ],
      },
      ctx,
      created[2].version,
    );
    expect(Number(edited.exchangeRate)).toBe(10_000);
    expect(Number(edited.total)).toBe(50_000);
    snap = await independentExpected();
    expectReconciled(snap);

    // Cancel unpaid invoice 4
    const cancelled = await invoiceRepo.cancel(created[3].id, ctx.userId, ctx, created[3].version);
    expect(cancelled.status).toBe("cancelled");
    snap = await independentExpected();
    expectReconciled(snap);

    // Return part of invoice 5 (20kg @ 10,000 → return 5kg)
    const [line5] = await db
      .select()
      .from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, created[4].id));
    await returnRepo.create(
      {
        kind: "sale",
        date: "2026-09-16",
        partyId: customerId,
        originalInvoiceId: created[4].id,
        reason: "defect",
        currency: "SYP",
        exchangeRate: 10_000,
        lines: [
          {
            rollId: line5.rollId,
            quantityKg: 5,
            pieces: 1,
            pricePerKg: Number(line5.pricePerKg),
          },
        ],
      },
      ctx,
    );
    snap = await independentExpected();
    expect(snap.syp.returns).toBe(50_000);
    expectReconciled(snap);

    // Later FX change must not rewrite historical documents
    const [inv10] = await db.select().from(invoices).where(eq(invoices.id, created[9].id));
    const [vocCross] = await db
      .select()
      .from(vouchers)
      .where(and(eq(vouchers.invoiceId, created[9].id), eq(vouchers.status, "active")));
    expect(Number(inv10.exchangeRate)).toBe(8_000);
    expect(Number(inv10.baseTotal)).toBe(computeBaseEquivalent(1_000_000, "SYP", 8_000));
    expect(Number(vocCross.exchangeRate)).toBe(10_000);
    expect(Number(vocCross.amount)).toBe(100);
    expect(Number(vocCross.baseAmount)).toBe(100);

    const later = await voucherRepo.create(
      {
        kind: "receipt",
        date: "2026-09-16",
        partyId: customerId,
        partyKind: "customer",
        invoiceId: created[5].id,
        amount: 100_000,
        currency: "SYP",
        exchangeRate: 15_000,
        method: "cash",
      },
      ctx,
    );
    expect(Number(later.exchangeRate)).toBe(15_000);
    const [inv10After] = await db.select().from(invoices).where(eq(invoices.id, created[9].id));
    const [vocCrossAfter] = await db.select().from(vouchers).where(eq(vouchers.id, vocCross.id));
    expect(Number(inv10After.exchangeRate)).toBe(8_000);
    expect(Number(vocCrossAfter.exchangeRate)).toBe(10_000);

    snap = await independentExpected();
    expectReconciled(snap);
    expect(snap.cashUsd).toBe(200);
    expect(snap.cashSyp).toBe(950_000);

    // Cross-currency voucher still balances in base (incl. explained fx_loss)
    const [fxBal] = await db
      .select({
        debit: sql<number>`COALESCE(SUM(${ledgerEntries.baseDebit}), 0)`,
        credit: sql<number>`COALESCE(SUM(${ledgerEntries.baseCredit}), 0)`,
      })
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.referenceId, vocCross.id),
          eq(ledgerEntries.tenantId, tenantId),
          eq(ledgerEntries.status, "active"),
        ),
      );
    expect(round2dp(Number(fxBal.debit))).toBe(round2dp(Number(fxBal.credit)));
    const fxLegs = await db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.referenceId, vocCross.id),
          sql`${ledgerEntries.type} in ('fx_gain','fx_loss')`,
          eq(ledgerEntries.status, "active"),
        ),
      );
    expect(fxLegs).toHaveLength(1);
    expect(fxLegs[0].type).toBe("fx_loss");
    expect(Number(fxLegs[0].debit)).toBe(25);
  });
});
