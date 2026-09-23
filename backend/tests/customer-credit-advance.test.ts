/**
 * Customer advance payments / overpayment → credit balance → spent on the next
 * sale → shortfall becomes debt. Real repositories on live Postgres.
 *
 * The invariants checked at every step:
 *  - an overpaid invoice is closed exactly (paid = total), never refused;
 *  - the FULL cash lands in the cashbox (cash leg = money that moved);
 *  - the customer ledger balance, the statement final balance, and
 *    (open invoice remainders − available credit) always agree;
 *  - a cancel that would destroy credit already spent on another invoice is refused.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
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
import { PostgresPartyRepository } from "@/infrastructure/repositories/PostgresPartyRepository.js";
import { PostgresAuditRepository } from "@/infrastructure/repositories/PostgresAuditRepository.js";
import { getCashboxBalanceAsOf } from "@/infrastructure/repositories/cashboxBalanceHelper.js";
import {
  customerCreditPosition,
  splitOverpayment,
} from "@/infrastructure/repositories/customerCredit.js";
import { settleInvoicesUseCase } from "@/application/use-cases/statements/settleInvoicesUseCase.js";
import { BusinessRuleError } from "@/domain/errors/index.js";
import type { TenantContext } from "@/domain/types/index.js";
import { databaseReachable } from "./_helpers/requireDatabase.js";

const tenantId = randomUUID();
const customerId = randomUUID();
const supplierId = randomUUID();
const fabricId = randomUUID();
const colorId = randomUUID();
const DATE = "2026-09-20";
const ctx: TenantContext = {
  tenantId,
  userId: randomUUID(),
  userRole: "admin",
  userName: "credit-tester",
};

const invoiceRepo = new PostgresInvoiceRepository(db);
const rollRepo = new PostgresRollRepository(db);
const voucherRepo = new PostgresVoucherRepository(db);
const statements = new PostgresStatementRepository(db);

let reachable = false;

async function sell(total: number, extra: { paid?: number; creditApplied?: number } = {}) {
  const roll = await rollRepo.create(
    {
      colorId,
      rollNo: `R-${randomUUID().slice(0, 8)}`,
      initialKg: 100,
      remainingKg: 100,
      pieces: 1,
      pricePerKg: 1,
      currency: "USD",
      supplierId,
      entryDate: "2026-09-01",
    },
    ctx,
  );
  return invoiceRepo.create(
    {
      type: "sale",
      date: DATE,
      partyId: customerId,
      partyType: "customer",
      currency: "USD",
      exchangeRate: 1,
      lines: [
        { fabricId, colorId, rollId: roll.id, quantityKg: 100, pieces: 1, pricePerKg: total / 100 },
      ],
      ...(extra.paid !== undefined ? { paid: extra.paid, paymentMethod: "cash" as const } : {}),
      ...(extra.creditApplied !== undefined ? { creditApplied: extra.creditApplied } : {}),
    },
    ctx,
  );
}

const receipt = (amount: number, invoiceId?: string) =>
  voucherRepo.create(
    {
      kind: "receipt",
      date: DATE,
      partyId: customerId,
      partyKind: "customer",
      ...(invoiceId ? { invoiceId } : {}),
      amount,
      currency: "USD",
      exchangeRate: 1,
      method: "cash",
    },
    ctx,
  );

async function invoiceRow(id: string) {
  const [r] = await db
    .select({ paid: invoices.paid, total: invoices.total, creditApplied: invoices.creditApplied })
    .from(invoices)
    .where(eq(invoices.id, id));
  return { paid: Number(r.paid), total: Number(r.total), creditApplied: Number(r.creditApplied) };
}

async function snapshot() {
  const pos = await customerCreditPosition(db, tenantId, customerId, "USD");
  const stmt = await statements.getStatement(
    { partyId: customerId, kind: "customer", currency: "USD" },
    ctx,
  );
  const cash = await db.transaction((tx) => getCashboxBalanceAsOf(tx, ctx, "USD", DATE));
  const [led] = await db
    .select({
      net: sql<number>`COALESCE(SUM(${ledgerEntries.debit} - ${ledgerEntries.credit}), 0)`,
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
  const ledger = round2dp(Number(led?.net ?? 0));
  // One truth: ledger = statement = open remainders − unattached credit.
  expect(stmt.finalBalance).toBe(ledger);
  expect(pos.ledgerBalance).toBe(ledger);
  expect(round2dp(pos.openInvoicesRemaining - pos.unattached)).toBe(ledger);
  return { pos, stmt, cash: round2dp(cash), ledger };
}

describe("customer credit: overpayment, advance, auto-deduct, debt", () => {
  beforeAll(async () => {
    reachable = await databaseReachable();
    if (!reachable) return;
    await db.insert(tenants).values({
      id: tenantId,
      name: "Credit Tenant",
      slug: `credit-${tenantId.slice(0, 8)}`,
    });
    await db.insert(parties).values([
      {
        id: customerId,
        tenantId,
        name: "عميل الرصيد",
        code: "CR-C",
        kind: "customer",
        currency: "USD",
      },
      { id: supplierId, tenantId, name: "مورد", code: "CR-S", kind: "supplier", currency: "USD" },
    ]);
    await db.insert(fabrics).values({ id: fabricId, tenantId, name: "Cotton", minStockKg: "0" });
    await db.insert(colors).values({ id: colorId, tenantId, fabricId, name: "White" });
  });

  it("splitOverpayment", () => {
    expect(splitOverpayment(20_000, 10_000)).toEqual({ applied: 10_000, excess: 10_000 });
    expect(splitOverpayment(5_000, 10_000)).toEqual({ applied: 5_000, excess: 0 });
    expect(splitOverpayment(10_000.01, 10_000)).toEqual({ applied: 10_000.01, excess: 0 });
    expect(splitOverpayment(300, 0)).toEqual({ applied: 0, excess: 300 });
  });

  it("walks the full scenario", async () => {
    if (!reachable) return;

    // 1. Invoice 10,000 paid with 20,000 → paid, 10,000 credit, 20,000 in the drawer.
    const a = await sell(10_000);
    const overpay = await receipt(20_000, a.id);
    expect(overpay.appliedAmount).toBe(10_000);
    expect(await invoiceRow(a.id)).toMatchObject({ paid: 10_000, total: 10_000 });
    let s = await snapshot();
    expect(s.cash).toBe(20_000);
    expect(s.ledger).toBe(-10_000);
    expect(s.pos.availableCredit).toBe(10_000);
    expect(s.stmt.totalsByCurrency?.USD.balanceSide).toBe("credit");
    expect(s.stmt.totalsByCurrency?.USD.availableCredit).toBe(10_000);
    const overpayRow = s.stmt.entries.find((e) => e.referenceId === overpay.id);
    expect(overpayRow?.document?.advanceAmount).toBe(10_000);

    // 2. Advance payment on account (no invoice) → +5,000 credit, +5,000 cash.
    const onAccount = await receipt(5_000);
    s = await snapshot();
    expect(s.cash).toBe(25_000);
    expect(s.pos.availableCredit).toBe(15_000);
    expect(
      s.stmt.entries.find((e) => e.referenceId === onAccount.id)?.document?.advanceAmount,
    ).toBe(5_000);

    // 3. New sale 12,000 fully settled from credit — no cash moves.
    const b = await sell(12_000, { creditApplied: 12_000 });
    expect(await invoiceRow(b.id)).toMatchObject({ paid: 12_000, creditApplied: 12_000 });
    s = await snapshot();
    expect(s.cash).toBe(25_000);
    expect(s.pos.availableCredit).toBe(3_000);
    expect(s.ledger).toBe(-3_000);

    // 4. Asking for more credit than available is refused…
    await expect(sell(8_000, { creditApplied: 3_000.5 })).rejects.toBeInstanceOf(BusinessRuleError);
    // …using what is left turns the shortfall into debt (مدين).
    const c = await sell(8_000, { creditApplied: 3_000 });
    expect(await invoiceRow(c.id)).toMatchObject({ paid: 3_000, creditApplied: 3_000 });
    s = await snapshot();
    expect(s.pos.availableCredit).toBe(0);
    expect(s.ledger).toBe(5_000);
    expect(s.stmt.totalsByCurrency?.USD.balanceSide).toBe("debit");

    // 5. Overpayment captured AT invoice creation: 15,000 cash on a 10,000 sale.
    const d = await sell(10_000, { paid: 15_000 });
    expect(await invoiceRow(d.id)).toMatchObject({ paid: 10_000 });
    s = await snapshot();
    expect(s.cash).toBe(40_000);
    expect(s.ledger).toBe(0); // 5,000 debt on C offset by 5,000 credit
    expect(s.pos.availableCredit).toBe(5_000);

    // 6. Cancelling the first overpaid receipt would destroy credit already
    //    spent on invoice B → refused, nothing changes.
    await expect(voucherRepo.cancel(overpay.id, ctx.userId, ctx, overpay.version)).rejects.toThrow(
      /رصيد دائن/,
    );
    s = await snapshot();
    expect(s.cash).toBe(40_000);

    // 7. Multi-invoice settlement paying more than due: the excess becomes an
    //    on-account receipt (it used to be dropped — cash in drawer, not in books).
    const e = await sell(1_000);
    const settled = await settleInvoicesUseCase(
      voucherRepo,
      new PostgresAuditRepository(db),
      new PostgresPartyRepository(db),
      customerId,
      "customer",
      { invoiceIds: [e.id], amountPaid: 1_500, currency: "USD", exchangeRate: 1, date: DATE },
      ctx,
    );
    expect(settled.ok).toBe(true);
    if (settled.ok) {
      expect(settled.data.advance?.amount).toBe(500);
      expect(settled.data.vouchers).toHaveLength(2);
    }
    expect(await invoiceRow(e.id)).toMatchObject({ paid: 1_000 });
    s = await snapshot();
    expect(s.cash).toBe(41_500);
    expect(s.pos.availableCredit).toBe(5_500);
  });
});
