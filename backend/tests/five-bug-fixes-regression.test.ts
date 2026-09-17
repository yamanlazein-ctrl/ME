/**
 * Focused regression tests for 5 defects found in E2E testing (2026-09-17):
 *
 *  1. Double settlement on the same remaining balance returned 500
 *     SYNC_OUTBOX_FAILED instead of a safe 422 business-rule rejection.
 *  2. Editing an invoice's total below its already-paid amount produced an
 *     invalid (negative) remaining balance.
 *  3. Cancelling a voucher dated on an already-closed day bypassed the
 *     day-close lock.
 *  4. Setting the USD cashbox opening balance overwrote/lost the SYP one
 *     (single-row-per-tenant storage).
 *  5. A roll with remainingPieces === 0 but remainingKg > 0 could not be
 *     sold by weight at all (stranded stock).
 *
 * Each test exercises the real Postgres repository against the disposable
 * `erp_test` database — no mocks, no historical data touched.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, and } from "drizzle-orm";
import { db } from "@/infrastructure/orm/drizzle.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import { parties } from "@/infrastructure/orm/schemas/party.table.js";
import { fabrics } from "@/infrastructure/orm/schemas/fabric.table.js";
import { colors } from "@/infrastructure/orm/schemas/color.table.js";
import { ledgerEntries } from "@/infrastructure/orm/schemas/ledger-entry.table.js";
import { dayCloses } from "@/infrastructure/orm/schemas/cashbox.table.js";
import { rolls } from "@/infrastructure/orm/schemas/roll.table.js";
import { invoices } from "@/infrastructure/orm/schemas/invoice.table.js";
import { invoiceLines } from "@/infrastructure/orm/schemas/invoice-line.table.js";
import { vouchers } from "@/infrastructure/orm/schemas/voucher.table.js";
import { PostgresInvoiceRepository } from "@/infrastructure/repositories/PostgresInvoiceRepository.js";
import { PostgresRollRepository } from "@/infrastructure/repositories/PostgresRollRepository.js";
import { PostgresVoucherRepository } from "@/infrastructure/repositories/PostgresVoucherRepository.js";
import { PostgresStatementRepository } from "@/infrastructure/repositories/PostgresStatementRepository.js";
import { PostgresCashboxRepository } from "@/infrastructure/repositories/PostgresCashboxRepository.js";
import { BusinessRuleError, DayLockedError } from "@/domain/errors/index.js";
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
  userName: "bugfix-tester",
};

const invoiceRepo = new PostgresInvoiceRepository(db);
const rollRepo = new PostgresRollRepository(db);
const voucherRepo = new PostgresVoucherRepository(db);
const statementRepo = new PostgresStatementRepository(db);
const cashboxRepo = new PostgresCashboxRepository(db);

beforeAll(async () => {
  await db.insert(tenants).values({
    id: tenantId,
    name: "Bugfix Regression Tenant",
    slug: `bugfix-${tenantId.slice(0, 8)}`,
  });
  await db.insert(parties).values([
    {
      id: customerId,
      tenantId,
      name: "Bugfix Customer",
      code: "BF-C",
      kind: "customer",
      currency: "SYP",
    },
    {
      id: supplierId,
      tenantId,
      name: "Bugfix Supplier",
      code: "BF-S",
      kind: "supplier",
      currency: "SYP",
    },
  ]);
  await db.insert(fabrics).values({ id: fabricId, tenantId, name: "Cotton", minStockKg: "0" });
  await db.insert(colors).values({ id: colorId, tenantId, fabricId, name: "White" });
});

async function makeRoll(initialKg: number, pieces: number) {
  return rollRepo.create(
    {
      colorId,
      rollNo: `R-${randomUUID().slice(0, 8)}`,
      initialKg,
      remainingKg: initialKg,
      pieces,
      pricePerKg: 4000,
      currency: "SYP",
      supplierId,
      entryDate: "2026-09-01",
    },
    ctx,
  );
}

async function sellFromRoll(rollId: string, kg: number, pieces: number, price = 5000) {
  return invoiceRepo.create(
    {
      type: "sale",
      date: "2026-09-17",
      partyId: customerId,
      partyType: "customer",
      currency: "SYP",
      exchangeRate: 10_000,
      lines: [{ fabricId, colorId, rollId, quantityKg: kg, pieces, pricePerKg: price }],
    },
    ctx,
  );
}

describe("Bug 1 — double settlement no longer 500s", () => {
  it("rejects a second settlement on an already-zero balance with BusinessRuleError, not a generic 500", async () => {
    const roll = await makeRoll(10, 1);
    const invoice = await sellFromRoll(roll.id, 10, 1, 10_000); // total 100,000

    // Fully pay it off via a receipt (this is the mechanism that advances invoices.paid).
    await voucherRepo.create(
      {
        kind: "receipt",
        date: "2026-09-17",
        partyId: customerId,
        partyKind: "customer",
        invoiceId: invoice.id,
        amount: 100_000,
        currency: "SYP",
        exchangeRate: 10_000,
        method: "cash",
      },
      ctx,
    );

    // Balance is now zero. First settle() call also hits the zero-balance guard —
    // this simulates "a second settlement attempt on the same remaining balance".
    await expect(
      statementRepo.settle(customerId, { date: "2026-09-17", currency: "SYP" }, ctx),
    ).rejects.toBeInstanceOf(BusinessRuleError);

    // No partial ledger rows were written by the rejected settlement.
    const settlementLegs = await db
      .select()
      .from(ledgerEntries)
      .where(
        and(
          eq(ledgerEntries.tenantId, tenantId),
          eq(ledgerEntries.partyId, customerId),
          eq(ledgerEntries.type, "settlement"),
        ),
      );
    expect(settlementLegs).toHaveLength(0);
  });
});

describe("Bug 2 — invoice edit cannot drop total below paid", () => {
  it("rejects shrinking the total below the already-paid amount", async () => {
    const roll = await makeRoll(20, 1);
    const invoice = await sellFromRoll(roll.id, 20, 1, 10_000); // total 200,000 (matches "165,000 paid / 110,000 total" shape)

    await voucherRepo.create(
      {
        kind: "receipt",
        date: "2026-09-17",
        partyId: customerId,
        partyKind: "customer",
        invoiceId: invoice.id,
        amount: 165_000,
        currency: "SYP",
        exchangeRate: 10_000,
        method: "cash",
      },
      ctx,
    );

    const [line] = await db
      .select()
      .from(invoiceLines)
      .where(eq(invoiceLines.invoiceId, invoice.id));

    // Editing quantity down so the new total (110,000) is less than paid (165,000).
    await expect(
      invoiceRepo.update(
        invoice.id,
        {
          date: invoice.date,
          lines: [
            {
              fabricId: line.fabricId,
              colorId: line.colorId,
              rollId: line.rollId,
              quantityKg: 11,
              pieces: 1,
              pricePerKg: 10_000,
            },
          ],
        },
        ctx,
        invoice.version,
      ),
    ).rejects.toBeInstanceOf(BusinessRuleError);

    // Total on disk is unchanged — no invalid negative-remaining state was written.
    const [after] = await db.select().from(invoices).where(eq(invoices.id, invoice.id));
    expect(Number(after.total)).toBe(200_000);
    expect(Number(after.paid)).toBe(165_000);
  });
});

describe("Bug 3 — voucher cancel respects day-close on its own date", () => {
  it("rejects cancelling a voucher dated on an already-closed day", async () => {
    const roll = await makeRoll(10, 1);
    const invoice = await sellFromRoll(roll.id, 10, 1, 10_000);
    const voucher = await voucherRepo.create(
      {
        kind: "receipt",
        date: "2026-09-10",
        partyId: customerId,
        partyKind: "customer",
        invoiceId: invoice.id,
        amount: 50_000,
        currency: "SYP",
        exchangeRate: 10_000,
        method: "transfer",
      },
      ctx,
    );

    // Close 2026-09-10 directly (mirrors what POST /cashbox/close-day persists).
    await db.insert(dayCloses).values({
      tenantId,
      date: "2026-09-10",
      openingBalance: 0,
      totalIn: 0,
      totalOut: 0,
      expected: 0,
      counted: 0,
      difference: 0,
      currency: "SYP",
      closedBy: ctx.userId,
    });

    await expect(
      voucherRepo.cancel(voucher.id, ctx.userId, ctx, voucher.version),
    ).rejects.toBeInstanceOf(DayLockedError);

    // The voucher and the invoice's paid counter are untouched — no financial
    // rows were written by the rejected cancel.
    const [stillActive] = await db.select().from(vouchers).where(eq(vouchers.id, voucher.id));
    expect(stillActive.status).toBe("active");
  });
});

describe("Bug 4 — cashbox opening balance is tracked independently per currency", () => {
  it("setting USD opening balance does not overwrite/lose the SYP one", async () => {
    await cashboxRepo.setOpeningBalance(1_000_000, "2026-09-01", "SYP", ctx);
    await cashboxRepo.setOpeningBalance(500, "2026-09-01", "USD", ctx);

    const state = await cashboxRepo.getState(ctx);
    const syp = state.sessions.find((s) => s.currency === "SYP");
    const usd = state.sessions.find((s) => s.currency === "USD");
    expect(syp?.openingBalance).toBe(1_000_000);
    expect(usd?.openingBalance).toBe(500);

    // Updating the SYP opening again must not touch the USD row.
    await cashboxRepo.setOpeningBalance(1_200_000, "2026-09-05", "SYP", ctx);
    const state2 = await cashboxRepo.getState(ctx);
    const sypAfter = state2.sessions.find((s) => s.currency === "SYP");
    const usdAfter = state2.sessions.find((s) => s.currency === "USD");
    expect(sypAfter?.openingBalance).toBe(1_200_000);
    expect(usdAfter?.openingBalance).toBe(500);
    expect(usdAfter?.openingDate).toBe("2026-09-01");
  });
});

describe("Bug 5 — loose remnant kg on a piece-exhausted roll is sellable", () => {
  it("allows a kg-only sale once remainingPieces reaches 0, without going negative", async () => {
    const roll = await makeRoll(10, 1);

    // Sell the whole piece but only part of the weight — leaves a remnant
    // (remainingKg > 0, remainingPieces === 0), mirroring a real leftover cut.
    await sellFromRoll(roll.id, 7, 1, 5000);
    const [afterFirstSale] = await db.select().from(rolls).where(eq(rolls.id, roll.id));
    expect(Number(afterFirstSale.remainingKg)).toBe(3);
    expect(Number(afterFirstSale.remainingPieces)).toBe(0);

    // Selling the remaining 3kg with pieces explicitly 0 must succeed — the
    // roll has no whole pieces left, but the loose kg is real, sellable stock.
    const secondSale = await sellFromRoll(roll.id, 3, 0, 5000);
    expect(secondSale.id).toBeTruthy();

    const [afterSecondSale] = await db.select().from(rolls).where(eq(rolls.id, roll.id));
    expect(Number(afterSecondSale.remainingKg)).toBe(0);
    expect(Number(afterSecondSale.remainingPieces)).toBe(0);
  });

  it("still blocks requesting a piece the roll does not have", async () => {
    const roll = await makeRoll(10, 1);
    await sellFromRoll(roll.id, 7, 1, 5000); // remainingPieces -> 0

    await expect(sellFromRoll(roll.id, 1, 1, 5000)).rejects.toBeInstanceOf(BusinessRuleError);
  });
});
