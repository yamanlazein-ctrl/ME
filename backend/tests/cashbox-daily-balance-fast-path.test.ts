import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "@/infrastructure/orm/drizzle.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import {
  cashboxDailyBalances,
  cashboxSessions,
  manualMovements,
} from "@/infrastructure/orm/schemas/cashbox.table.js";
import {
  getCashboxBalanceAsOf,
  recomputeCashboxBalanceAsOf,
} from "@/infrastructure/repositories/cashboxBalanceHelper.js";
import type { TenantContext } from "@/domain/types/index.js";
import { databaseReachable } from "./_helpers/requireDatabase.js";

/**
 * Phase 5: rolling daily balances must match full recompute after thousands
 * of cash movements (trigger-maintained fast path).
 */
describe("cashbox daily balance fast path", () => {
  const tenantId = randomUUID();
  const ctx: TenantContext = {
    tenantId,
    userId: randomUUID(),
    userRole: "admin",
    userName: "cashbox-fast-path",
  };
  let reachable = false;

  beforeAll(async () => {
    reachable = await databaseReachable();
    if (!reachable) return;
    try {
      await db.insert(tenants).values({
        id: tenantId,
        name: "Cashbox Fast Path",
        slug: `cfp-${tenantId.slice(0, 8)}`,
      });
      await db.insert(cashboxSessions).values({
        tenantId,
        openingBalance: 1_000_000,
        openingDate: "2026-01-01",
        currency: "SYP",
      });
    } catch {
      reachable = false;
    }
  });

  it("fast path equals full recompute after 3000+ manual movements", async () => {
    if (!reachable) return;

    const N = 3200;
    const rows = Array.from({ length: N }, (_, i) => ({
      tenantId,
      date: i % 2 === 0 ? "2026-06-01" : "2026-06-15",
      type: "capital" as const,
      direction: (i % 3 === 0 ? "out" : "in") as "in" | "out",
      amount: 10 + (i % 7),
      currency: "SYP",
      description: `seed-${i}`,
    }));

    const chunk = 400;
    for (let i = 0; i < rows.length; i += chunk) {
      await db.insert(manualMovements).values(rows.slice(i, i + chunk));
    }

    await db.transaction(async (tx) => {
      await tx.execute(sql`SELECT set_config('app.current_tenant_id', ${tenantId}, true)`);

      for (const asOf of ["2026-06-01", "2026-06-15", "2026-06-30"]) {
        const fast = await getCashboxBalanceAsOf(tx, ctx, "SYP", asOf);
        const full = await recomputeCashboxBalanceAsOf(tx, ctx, "SYP", asOf);
        expect(fast).toBe(full);
      }

      const dailyRows = await tx
        .select({ date: cashboxDailyBalances.balanceDate })
        .from(cashboxDailyBalances)
        .where(eq(cashboxDailyBalances.tenantId, tenantId));
      expect(dailyRows.length).toBeGreaterThanOrEqual(1);
    });
  }, 120_000);
});
