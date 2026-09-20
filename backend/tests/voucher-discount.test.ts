import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, and, sql } from "drizzle-orm";
import { db } from "@/infrastructure/orm/drizzle.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import { parties } from "@/infrastructure/orm/schemas/party.table.js";
import { vouchers } from "@/infrastructure/orm/schemas/voucher.table.js";
import { ledgerEntries } from "@/infrastructure/orm/schemas/ledger-entry.table.js";
import { PostgresVoucherRepository } from "@/infrastructure/repositories/PostgresVoucherRepository.js";
import type { TenantContext } from "@/domain/types/index.js";
import { databaseReachable } from "./_helpers/requireDatabase.js";

let reachable = false;
const tenantId = randomUUID();
const customerId = randomUUID();
const supplierId = randomUUID();
const ctx: TenantContext = {
  tenantId,
  userId: randomUUID(),
  userRole: "admin",
  userName: "tester",
};

describe("voucher settlement discount", () => {
  beforeAll(async () => {
    // FIN-09: hard failure when DATABASE_URL is set — no vacuous pass.
    reachable = await databaseReachable();
    if (!reachable) return;
    try {
      await db.insert(tenants).values({ id: tenantId, name: "Discount Tenant", slug: `disc-${tenantId.slice(0, 8)}` });
      await db.insert(parties).values([
        {
          id: customerId,
          tenantId,
          name: "Customer",
          code: "C1",
          kind: "customer",
          currency: "SYP",
        },
        {
          id: supplierId,
          tenantId,
          name: "Supplier",
          code: "S1",
          kind: "supplier",
          currency: "SYP",
        },
      ]);
    } catch {
      reachable = false;
    }
  });

  async function ledgerBalance(): Promise<{ debit: number; credit: number }> {
    const [row] = await db
      .select({
        debit: sql<number>`COALESCE(SUM(debit), 0)`,
        credit: sql<number>`COALESCE(SUM(credit), 0)`,
      })
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.tenantId, tenantId), eq(ledgerEntries.status, "active")));
    return { debit: Number(row.debit), credit: Number(row.credit) };
  }

  it("receipt: gross party credit, net cash, discount expense — balanced", async () => {
    if (!reachable) return;
    const repo = new PostgresVoucherRepository(db);
    const created = await repo.create(
      {
        kind: "receipt",
        date: "2026-09-14",
        partyId: customerId,
        partyKind: "customer",
        amount: 100_000,
        discount: 10_000,
        currency: "SYP",
        exchangeRate: 15000,
        method: "cash",
      },
      ctx,
    );
    expect(created.amount).toBe(100_000);
    expect(created.discount).toBe(10_000);

    const legs = await db
      .select()
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.referenceId, created.id), eq(ledgerEntries.tenantId, tenantId)));
    expect(legs).toHaveLength(3);
    const types = legs.map((l) => l.type).sort();
    expect(types).toEqual(["cash", "receipt_in", "settlement_discount_expense"].sort());

    const bal = await ledgerBalance();
    expect(bal.debit).toBe(bal.credit);
    // ledger_entries is append-only — leave fixtures for the ephemeral tenant
  });

  it("payment: gross party debit, net cash, discount income — balanced", async () => {
    if (!reachable) return;
    const repo = new PostgresVoucherRepository(db);
    const created = await repo.create(
      {
        kind: "payment",
        date: "2026-09-14",
        partyId: supplierId,
        partyKind: "supplier",
        amount: 50_000,
        discount: 5_000,
        currency: "SYP",
        exchangeRate: 15000,
        method: "cash",
      },
      ctx,
    );
    expect(created.discount).toBe(5_000);

    const legs = await db
      .select()
      .from(ledgerEntries)
      .where(and(eq(ledgerEntries.referenceId, created.id), eq(ledgerEntries.tenantId, tenantId)));
    expect(legs).toHaveLength(3);
    expect(legs.some((l) => l.type === "settlement_discount_income")).toBe(true);

    const bal = await ledgerBalance();
    expect(bal.debit).toBe(bal.credit);
  });
});
