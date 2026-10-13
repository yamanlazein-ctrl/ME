/**
 * Statement order: an invoice and the receipt booked WITH it (paid at sale time) are written in one
 * transaction, so they share date and created_at. The statement used to break that tie by the random
 * row id, so the receipt could come first and the running balance showed the customer in credit
 * (−4) before the sale. Documents (invoices/returns) must precede their payments on a tie, and every
 * way of paging the statement (cursor and page number) must agree with the full window.
 * Engine-agnostic: runs on SQLite and PostgreSQL.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/infrastructure/orm/drizzle.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import { parties } from "@/infrastructure/orm/schemas/party.table.js";
import { fabrics } from "@/infrastructure/orm/schemas/fabric.table.js";
import { colors } from "@/infrastructure/orm/schemas/color.table.js";
import { PostgresInvoiceRepository } from "@/infrastructure/repositories/PostgresInvoiceRepository.js";
import { PostgresRollRepository } from "@/infrastructure/repositories/PostgresRollRepository.js";
import { PostgresStatementRepository } from "@/infrastructure/repositories/PostgresStatementRepository.js";
import type { TenantContext } from "@/domain/types/index.js";

const tenantId = randomUUID();
const customerId = randomUUID();
const fabricId = randomUUID();
const colorId = randomUUID();
const ctx: TenantContext = {
  tenantId,
  userId: randomUUID(),
  userRole: "admin",
  userName: "order-tester",
};
const SALES = 8; // 8 coin flips: an id tie-break orders every pair correctly with p = 1/256

const invoiceRepo = new PostgresInvoiceRepository(db);
const rollRepo = new PostgresRollRepository(db);
const statements = new PostgresStatementRepository(db);
const query = { partyId: customerId, kind: "customer" as const, currency: "USD" };

type Row = { id: string; type: string; runningBalance: number };
const brief = (rows: Row[]) =>
  rows.map((r) => ({ id: r.id, type: r.type, runningBalance: r.runningBalance }));

describe("statement order: a document precedes the payment booked with it", () => {
  beforeAll(async () => {
    await db.execute(sql`select 1`);
    await db
      .insert(tenants)
      .values({ id: tenantId, name: "Order Tenant", slug: `order-${tenantId.slice(0, 8)}` });
    await db.insert(parties).values({
      id: customerId,
      tenantId,
      name: "Order Customer",
      code: "ORD-C",
      kind: "customer",
      currency: "USD",
    });
    await db.insert(fabrics).values({ id: fabricId, tenantId, name: "Cotton", minStockKg: "0" });
    await db.insert(colors).values({ id: colorId, tenantId, fabricId, name: "White" });
    for (let i = 0; i < SALES; i++) {
      const roll = await rollRepo.create(
        {
          colorId,
          rollNo: `R-${randomUUID().slice(0, 8)}`,
          initialKg: 5,
          remainingKg: 5,
          pieces: 1,
          pricePerKg: 1,
          currency: "USD",
          entryDate: "2026-09-01",
        },
        ctx,
      );
      // 1 kg × $10, $4 paid in cash with the sale → invoice leg + receipt leg in one transaction.
      await invoiceRepo.create(
        {
          type: "sale",
          date: "2026-09-16",
          partyId: customerId,
          partyType: "customer",
          currency: "USD",
          exchangeRate: 10_000,
          paid: 4,
          paymentMethod: "cash",
          lines: [{ fabricId, colorId, rollId: roll.id, quantityKg: 1, pieces: 1, pricePerKg: 10 }],
        } as never,
        ctx,
      );
    }
  }, 120_000);

  it("lists every invoice before its own receipt; the balance never shows a false credit", async () => {
    const full = (await statements.getStatement(query, ctx)).entries as Row[];
    expect(full.map((r) => r.type)).toEqual(
      Array.from({ length: SALES }, () => ["sales_invoice", "receipt_in"]).flat(),
    );
    expect(full.map((r) => r.runningBalance)).toEqual(
      Array.from({ length: SALES }, (_, i) => [i * 6 + 10, i * 6 + 6]).flat(),
    );
  });

  it("cursor paging returns exactly the full window, in the same order, with the same balances", async () => {
    const full = brief((await statements.getStatement(query, ctx)).entries as Row[]);
    const walked: Row[] = [];
    let cursor: string | undefined;
    for (let guard = 0; guard < 50; guard++) {
      const page = await statements.getStatement({ ...query, limit: 3, cursor }, ctx);
      walked.push(...(page.entries as Row[]));
      if (!page.page?.nextCursor) break;
      cursor = page.page.nextCursor;
    }
    expect(brief(walked)).toEqual(full);
  });

  it("page-number paging (0, 1, 2 …) returns exactly the full window with carried balances", async () => {
    const full = brief((await statements.getStatement(query, ctx)).entries as Row[]);
    const paged: Row[] = [];
    for (let p = 0; p * 3 < full.length; p++) {
      paged.push(
        ...((await statements.getStatement({ ...query, limit: 3, page: p }, ctx)).entries as Row[]),
      );
    }
    expect(brief(paged)).toEqual(full);
  });
});
