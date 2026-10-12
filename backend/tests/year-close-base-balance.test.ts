/**
 * CODEBASE_AUDIT_REPORT M-13 — the year-close "unbalanced document" check must not add USD and SYP
 * nominal amounts together. Engine-agnostic (SQLite + PG via financialYearHelpers).
 *  - a USD receipt settling an SYP invoice (balanced in base) is NOT a blocker;
 *  - a document balanced nominally but not in base (the H-03 shape) IS one.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/infrastructure/orm/drizzle.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import { parties } from "@/infrastructure/orm/schemas/party.table.js";
import { invoices } from "@/infrastructure/orm/schemas/invoice.table.js";
import { ledgerEntries } from "@/infrastructure/orm/schemas/ledger-entry.table.js";
import { PostgresVoucherRepository } from "@/infrastructure/repositories/PostgresVoucherRepository.js";
import { financialYearHelpers } from "@/infrastructure/repositories/engineHelpers.js";
import type { TenantContext } from "@/domain/types/index.js";

const customerId = randomUUID();
const DATE = "2027-03-01";

const leg = (tenantId: string, refType: string, refId: string, o: Record<string, unknown>) => ({
  tenantId,
  date: DATE,
  cashImpact: "none" as const,
  referenceType: refType,
  referenceId: refId,
  referenceNumber: refType,
  description: refType,
  debit: 0,
  credit: 0,
  ...o,
});

async function unbalancedBlockers(ctx: TenantContext) {
  const h = await financialYearHelpers();
  const preview = await db.transaction((tx) => h.getYearClosingPreview(tx as never, ctx, 2027));
  return preview.blockers.filter((b: string) => b.includes("غير متوازنة"));
}

async function tenantCtx(): Promise<TenantContext> {
  const tenantId = randomUUID();
  await db
    .insert(tenants)
    .values({ id: tenantId, name: "M13", slug: `m13-${tenantId.slice(0, 8)}` });
  return { tenantId, userId: randomUUID(), userRole: "admin", userName: "m13" };
}

describe("year close: document balance across currencies", () => {
  beforeAll(async () => {
    await db.execute(sql`select 1`);
  });

  it("a USD receipt against an SYP invoice (balanced in base) does not block the close", async () => {
    const ctx = await tenantCtx();
    await db.insert(parties).values({
      id: customerId,
      tenantId: ctx.tenantId,
      name: "C",
      code: "M13-C",
      kind: "customer",
      currency: "SYP",
    });
    const invId = randomUUID();
    await db.insert(invoices).values({
      id: invId,
      tenantId: ctx.tenantId,
      number: "M13-INV",
      type: "sale",
      date: DATE,
      partyId: customerId,
      partyType: "customer",
      currency: "SYP",
      subtotal: 100_000,
      total: 100_000,
      paid: 0,
      exchangeRate: 10_000,
      baseTotal: 10,
    });
    await db.insert(ledgerEntries).values([
      leg(ctx.tenantId, "sales_invoice", invId, {
        partyId: customerId,
        type: "sales_invoice",
        debit: 100_000,
        currency: "SYP",
        exchangeRate: 10_000,
        baseDebit: 10,
        baseCredit: 0,
      }),
      leg(ctx.tenantId, "sales_invoice", invId, {
        type: "sales_revenue",
        credit: 100_000,
        currency: "SYP",
        exchangeRate: 10_000,
        baseDebit: 0,
        baseCredit: 10,
      }),
    ] as never);
    await new PostgresVoucherRepository(db).create(
      {
        kind: "receipt",
        date: DATE,
        partyId: customerId,
        partyKind: "customer",
        invoiceId: invId,
        amount: 10,
        currency: "USD",
        exchangeRate: 10_000,
        method: "cash",
      } as never,
      ctx,
    );
    expect(await unbalancedBlockers(ctx)).toEqual([]);
  });

  it("a document balanced nominally but not in base is a blocker", async () => {
    const ctx = await tenantCtx();
    const ref = randomUUID();
    await db.insert(ledgerEntries).values([
      leg(ctx.tenantId, "receipt_in", ref, {
        type: "cash",
        debit: 100_000,
        currency: "SYP",
        exchangeRate: 20_000,
        baseDebit: 5,
        baseCredit: 0,
      }),
      leg(ctx.tenantId, "receipt_in", ref, {
        type: "receipt_in",
        credit: 100_000,
        currency: "SYP",
        exchangeRate: 10_000,
        baseDebit: 0,
        baseCredit: 10,
      }),
    ] as never);
    expect(await unbalancedBlockers(ctx)).toHaveLength(1);
  });
});
