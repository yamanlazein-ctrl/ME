import { describe, it, expect, beforeAll } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "@/infrastructure/orm/drizzle.js";
import { ledgerEntries } from "@/infrastructure/orm/schemas/ledger-entry.table.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import { parties } from "@/infrastructure/orm/schemas/party.table.js";
import { randomUUID } from "node:crypto";

/**
 * Money precision regression (P0-MONEY).
 *
 * The ledger money columns were `real` (IEEE-754 single precision), which
 * cannot represent amounts above ~2^24 exactly. After migration 0026 they are
 * `bigint`, so every write→read round-trip is exact and SUM() is exact too.
 */
describe("money precision", () => {
  const tenantId = randomUUID();
  const partyId = randomUUID();

  beforeAll(async () => {
    await db
      .insert(tenants)
      .values({ id: tenantId, name: "Money Test", slug: `money-${tenantId.slice(0, 8)}` });
    await db.insert(parties).values({
      id: partyId,
      tenantId,
      name: "Money Test Party",
      code: "MONEY",
      kind: "customer",
      currency: "SYP",
    });
  });

  it("round-trips the four table values exactly", async () => {
    const values = [20_000_001, 45_678_903, 137_500_007, 260_000_005];
    for (const v of values) {
      const [row] = await db
        .insert(ledgerEntries)
        .values({
          tenantId,
          partyId,
          date: "2026-01-01",
          type: "cash",
          debit: v,
          credit: 0,
          currency: "SYP",
          cashImpact: "none",
          referenceType: "money-test",
          referenceId: randomUUID(),
          createdBy: randomUUID(),
        })
        .returning();
      expect(row.debit).toBe(v);
    }
  });

  it("sums N entries to the exact integer total", async () => {
    const amounts = [20_000_001, 45_678_903, 137_500_007, 260_000_005];
    const exactTotal = amounts.reduce((a, b) => a + b, 0);
    const [row] = await db
      .select({ total: sql`COALESCE(SUM(${ledgerEntries.debit}), 0)` })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.partyId, partyId));
    expect(Number(row?.total ?? 0)).toBe(exactTotal);
  });
});