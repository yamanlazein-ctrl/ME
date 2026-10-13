/**
 * F-008 — the SAME amount must come out identical from the JS layer (what is POSTED to the ledger)
 * and the SQL layer (what invoice "remaining", customer credit, profit and dashboards RE-COMPUTE).
 *
 * A sale line of q kg × p and its full return are posted by JS (`round2dp`); the voucher guard and
 * customer-credit read the return's value back as SQL `ROUND(q × p, 2)`. If the two disagree, a fully
 * returned invoice shows −0.01 / +0.01 "remaining" while its ledger nets to zero — a cent that never
 * clears and accumulates per affected document. Cases are half-cent products (q × p ends in 5 at the
 * third decimal), where binary floats and decimal rounding part ways. Engine-agnostic.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, isNotNull, sql } from "drizzle-orm";
import { db } from "@/infrastructure/orm/drizzle.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import { parties } from "@/infrastructure/orm/schemas/party.table.js";
import { fabrics } from "@/infrastructure/orm/schemas/fabric.table.js";
import { colors } from "@/infrastructure/orm/schemas/color.table.js";
import { invoices } from "@/infrastructure/orm/schemas/invoice.table.js";
import { ledgerEntries } from "@/infrastructure/orm/schemas/ledger-entry.table.js";
import { returnLines } from "@/infrastructure/orm/schemas/return-line.table.js";
import { returns } from "@/infrastructure/orm/schemas/return.table.js";
import { PostgresInvoiceRepository } from "@/infrastructure/repositories/PostgresInvoiceRepository.js";
import { PostgresRollRepository } from "@/infrastructure/repositories/PostgresRollRepository.js";
import { PostgresReturnRepository } from "@/infrastructure/repositories/PostgresReturnRepository.js";
import { PostgresVoucherRepository } from "@/infrastructure/repositories/PostgresVoucherRepository.js";
import { PostgresStatementRepository } from "@/infrastructure/repositories/PostgresStatementRepository.js";
import { customerCreditPosition } from "@/infrastructure/repositories/customerCredit.js";
import type { TenantContext } from "@/domain/types/index.js";
import { isSqliteRun } from "./_helpers/engine.js";

const tenantId = randomUUID();
const customerId = randomUUID();
const fabricId = randomUUID();
const colorId = randomUUID();
const ctx: TenantContext = {
  tenantId,
  userId: randomUUID(),
  userRole: "admin",
  userName: "rounding",
};

// q × p with a half cent at the 3rd decimal (each is a case where float and decimal can disagree).
const CASES: Array<[number, number]> = [
  [0.18, 1.25],
  [0.82, 1.25],
  [0.94, 1.25],
  [0.7, 0.05],
  [1.3, 0.15],
  [2.1, 0.35],
  [0.3, 2.35],
  [1.1, 10.05],
  [3.9, 12.55],
  [0.1, 4.45],
  [7.3, 0.25],
  [11.7, 1.15],
];

const round = (n: number) => Math.round(n * 100) / 100; // test-side comparison of already-2dp values
const rows = (r: unknown) =>
  (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as Array<
    Record<string, unknown>
  >;

describe("F-008: JS-posted amounts equal their SQL re-computation", () => {
  const results: Array<{
    q: number;
    p: number;
    posted: number;
    sqlTotal: number;
    invoiceTotal: number;
  }> = [];

  beforeAll(async () => {
    await db.execute(sql`select 1`);
    await db
      .insert(tenants)
      .values({ id: tenantId, name: "Rounding", slug: `rnd-${tenantId.slice(0, 8)}` });
    await db.insert(parties).values({
      id: customerId,
      tenantId,
      name: "C",
      code: "RND-C",
      kind: "customer",
      currency: "USD",
    });
    await db.insert(fabrics).values({ id: fabricId, tenantId, name: "Cotton", minStockKg: "0" });
    await db.insert(colors).values({ id: colorId, tenantId, fabricId, name: "White" });
    const invoiceRepo = new PostgresInvoiceRepository(db);
    const rollRepo = new PostgresRollRepository(db);
    const returnRepo = new PostgresReturnRepository(db);
    for (const [q, p] of CASES) {
      const roll = await rollRepo.create(
        {
          colorId,
          rollNo: `R-${randomUUID().slice(0, 8)}`,
          initialKg: 50,
          remainingKg: 50,
          pieces: 1,
          pricePerKg: 1,
          currency: "USD",
          entryDate: "2026-09-01",
        },
        ctx,
      );
      const inv = await invoiceRepo.create(
        {
          type: "sale",
          date: "2026-09-10",
          partyId: customerId,
          partyType: "customer",
          currency: "USD",
          lines: [{ fabricId, colorId, rollId: roll.id, quantityKg: q, pieces: 1, pricePerKg: p }],
        } as never,
        ctx,
      );
      const ret = await returnRepo.create(
        {
          kind: "sale",
          date: "2026-09-12",
          partyId: customerId,
          originalInvoiceId: inv.id,
          reason: "defect",
          currency: "USD",
          lines: [{ rollId: roll.id, quantityKg: q, pieces: 1, pricePerKg: p }],
        },
        ctx,
      );
      const [leg] = await db
        .select({ credit: ledgerEntries.credit })
        .from(ledgerEntries)
        .where(and(eq(ledgerEntries.referenceId, ret.id), isNotNull(ledgerEntries.partyId)));
      // Exactly what the voucher guard / customer-credit read back (PostgresVoucherRepository retAgg).
      // SQLite: the twin's exact scaled-integer expression (SqliteVoucherRepository retAgg).
      const { mulRound, scaledNumber } =
        await import("@/infrastructure/repositories/sqlite/helpers/likeContains.js");
      const sqlReturn = isSqliteRun
        ? scaledNumber(
            sql`COALESCE(SUM(${mulRound(returnLines.quantityKg, 2, returnLines.pricePerKg, 4, 2)}), 0)`,
            2,
          )
        : sql<number>`COALESCE(SUM(ROUND(${returnLines.quantityKg} * ${returnLines.pricePerKg}, 2)), 0)`;
      const [agg] = await db
        .select({ total: sqlReturn })
        .from(returnLines)
        .innerJoin(returns, eq(returnLines.returnId, returns.id))
        .where(eq(returns.id, ret.id));
      const [i] = await db
        .select({ total: invoices.total })
        .from(invoices)
        .where(eq(invoices.id, inv.id));
      results.push({
        q,
        p,
        posted: Number(leg!.credit),
        sqlTotal: Number(agg!.total),
        invoiceTotal: Number(i!.total),
      });
    }
    void rows;
  }, 180_000);

  it("a fully returned line: posted credit = SQL return value = invoice total (no stranded cent)", () => {
    const off = results.filter((r) => r.posted !== r.sqlTotal || r.posted !== r.invoiceTotal);
    // eslint-disable-next-line no-console
    if (off.length) console.log("[F-008] mismatches:", JSON.stringify(off));
    expect(off).toEqual([]);
  });

  it("sell → pay the exact total → partial return: the statement, the invoice remaining (SQL) and the customer credit agree to the cent", async () => {
    const tid = randomUUID();
    const cust = randomUUID();
    const c2: TenantContext = { ...ctx, tenantId: tid };
    await db
      .insert(tenants)
      .values({ id: tid, name: "Rounding 2", slug: `rnd2-${tid.slice(0, 8)}` });
    await db.insert(parties).values({
      id: cust,
      tenantId: tid,
      name: "C2",
      code: "RND2",
      kind: "customer",
      currency: "USD",
    });
    const fab = randomUUID();
    const col = randomUUID();
    await db.insert(fabrics).values({ id: fab, tenantId: tid, name: "Linen", minStockKg: "0" });
    await db.insert(colors).values({ id: col, tenantId: tid, fabricId: fab, name: "Blue" });
    const invoiceRepo = new PostgresInvoiceRepository(db);
    const rollRepo = new PostgresRollRepository(db);
    const returnRepo = new PostgresReturnRepository(db);
    const vouchers = new PostgresVoucherRepository(db);
    for (const [q, p] of CASES) {
      const roll = await rollRepo.create(
        {
          colorId: col,
          rollNo: `R-${randomUUID().slice(0, 8)}`,
          initialKg: 50,
          remainingKg: 50,
          pieces: 2,
          pricePerKg: 1,
          currency: "USD",
          entryDate: "2026-09-01",
        },
        c2,
      );
      const inv = await invoiceRepo.create(
        {
          type: "sale",
          date: "2026-09-10",
          partyId: cust,
          partyType: "customer",
          currency: "USD",
          lines: [
            {
              fabricId: fab,
              colorId: col,
              rollId: roll.id,
              quantityKg: q * 2,
              pieces: 2,
              pricePerKg: p,
            },
          ],
        } as never,
        c2,
      );
      await vouchers.create(
        {
          kind: "receipt",
          date: "2026-09-11",
          partyId: cust,
          partyKind: "customer",
          invoiceId: inv.id,
          amount: Number(inv.total),
          currency: "USD",
          method: "cash",
        } as never,
        c2,
      );
      await returnRepo.create(
        {
          kind: "sale",
          date: "2026-09-12",
          partyId: cust,
          originalInvoiceId: inv.id,
          reason: "defect",
          currency: "USD",
          lines: [{ rollId: roll.id, quantityKg: q, pieces: 1, pricePerKg: p }],
        },
        c2,
      );
    }
    // SYP invoice settled in USD at a rate whose conversion has a fraction; and a very large SYP line.
    const rollS = await rollRepo.create(
      {
        colorId: col,
        rollNo: `R-${randomUUID().slice(0, 8)}`,
        initialKg: 999,
        remainingKg: 999,
        pieces: 1,
        pricePerKg: 1,
        currency: "SYP",
        entryDate: "2026-09-01",
      },
      c2,
    );
    const big = await invoiceRepo.create(
      {
        type: "sale",
        date: "2026-09-10",
        partyId: cust,
        partyType: "customer",
        currency: "SYP",
        exchangeRate: 12700.5,
        lines: [
          {
            fabricId: fab,
            colorId: col,
            rollId: rollS.id,
            quantityKg: 987.65,
            pieces: 1,
            pricePerKg: 1234567,
          },
        ],
      } as never,
      c2,
    );
    await vouchers.create(
      {
        kind: "receipt",
        date: "2026-09-11",
        partyId: cust,
        partyKind: "customer",
        invoiceId: big.id,
        amount: 1000.37,
        currency: "USD",
        exchangeRate: 12700.5,
        method: "cash",
      } as never,
      c2,
    );

    const statements = new PostgresStatementRepository(db);
    // Posted return credits (ledger) vs the same returns re-computed by SQL (the voucher guard's form).
    const { mulRound, scaledNumber } =
      await import("@/infrastructure/repositories/sqlite/helpers/likeContains.js");
    const sqlReturn = isSqliteRun
      ? scaledNumber(
          sql`COALESCE(SUM(${mulRound(returnLines.quantityKg, 2, returnLines.pricePerKg, 4, 2)}), 0)`,
          2,
        )
      : sql<number>`COALESCE(SUM(ROUND(${returnLines.quantityKg} * ${returnLines.pricePerKg}, 2)), 0)`;
    const [sqlRet] = await db
      .select({ t: sqlReturn })
      .from(returnLines)
      .innerJoin(returns, eq(returnLines.returnId, returns.id))
      .where(eq(returns.tenantId, tid));
    const postedRet = (
      await db
        .select({ c: ledgerEntries.credit })
        .from(ledgerEntries)
        .where(
          and(
            eq(ledgerEntries.tenantId, tid),
            eq(ledgerEntries.type, "sales_return"),
            isNotNull(ledgerEntries.partyId),
          ),
        )
    ).reduce((t, r) => t + Number(r.c), 0);
    expect(round(postedRet), "posted return credits = SQL return values").toBe(
      round(Number(sqlRet!.t)),
    );

    for (const currency of ["USD", "SYP"]) {
      const stmt = await statements.getStatement({ partyId: cust, kind: "customer", currency }, c2);
      const pos = await customerCreditPosition(db as never, tid, cust, currency);
      expect(pos.ledgerBalance, `${currency}: credit position = statement`).toBe(
        round(stmt.finalBalance),
      );
      if (currency === "USD") {
        // every USD invoice is paid in full and half returned: exactly the returns are the customer's credit
        expect(pos.availableCredit, "USD credit = the posted returns").toBe(round(postedRet));
      } else {
        // the large SYP invoice: SQL remaining (total − paid) = the ledger balance, to the lira-cent
        const [b] = await db
          .select({ t: invoices.total, p: invoices.paid })
          .from(invoices)
          .where(eq(invoices.id, big.id));
        expect(round(Number(b!.t) - Number(b!.p)), "SYP remaining = statement").toBe(
          round(stmt.finalBalance),
        );
      }
    }
  }, 180_000);
});
