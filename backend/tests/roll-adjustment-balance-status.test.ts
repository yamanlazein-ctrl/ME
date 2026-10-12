/**
 * CODEBASE_AUDIT_REPORT H-06 / M-01 — a roll adjustment (count variance / manual / sync replay).
 * Engine-agnostic (SQLite + PG via engineHelpers).
 *  H-06: the journal balances — the P&L leg has its inventory-asset contra, nominal and (USD) base.
 *  M-01: restoring stock to an exhausted roll makes it sellable again; emptying it marks it exhausted.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { round2dp } from "@erp/shared";
import { db } from "@/infrastructure/orm/drizzle.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import { fabrics } from "@/infrastructure/orm/schemas/fabric.table.js";
import { colors } from "@/infrastructure/orm/schemas/color.table.js";
import { rolls } from "@/infrastructure/orm/schemas/roll.table.js";
import { ledgerEntries } from "@/infrastructure/orm/schemas/ledger-entry.table.js";
import { PostgresRollRepository } from "@/infrastructure/repositories/PostgresRollRepository.js";
import { inventoryCountHelpers } from "@/infrastructure/repositories/engineHelpers.js";
import type { TenantContext } from "@/domain/types/index.js";

const tenantId = randomUUID();
const fabricId = randomUUID();
const colorId = randomUUID();
const ctx: TenantContext = {
  tenantId,
  userId: randomUUID(),
  userRole: "admin",
  userName: "adj-tester",
};

const adjust = async (rollId: string, deltaKg: number, deltaPieces: number) => {
  const h = await inventoryCountHelpers();
  const referenceId = randomUUID();
  await db.transaction((tx) =>
    h.applyRollAdjustment(tx as never, ctx, {
      rollId,
      deltaKg,
      deltaPieces,
      reason: "تسوية",
      date: "2026-09-20",
      referenceType: "inventory_adjustment",
      referenceId,
      referenceNumber: `ADJ-${referenceId.slice(0, 6)}`,
    } as never),
  );
  return referenceId;
};

describe("roll adjustment: balanced journal and stock status", () => {
  let rollId = "";
  beforeAll(async () => {
    await db.execute(sql`select 1`);
    await db
      .insert(tenants)
      .values({ id: tenantId, name: "Adj", slug: `adj-${tenantId.slice(0, 8)}` });
    await db.insert(fabrics).values({ id: fabricId, tenantId, name: "Cotton", minStockKg: "0" });
    await db.insert(colors).values({ id: colorId, tenantId, fabricId, name: "White" });
    rollId = (
      await new PostgresRollRepository(db).create(
        {
          colorId,
          rollNo: `R-${randomUUID().slice(0, 8)}`,
          initialKg: 10,
          remainingKg: 10,
          pieces: 1,
          pricePerKg: 5,
          currency: "USD",
          entryDate: "2026-09-01",
        },
        ctx,
      )
    ).id;
  });

  const status = async () =>
    (await db.select({ s: rolls.status }).from(rolls).where(eq(rolls.id, rollId)))[0]!.s;

  it("M-01: emptying the roll exhausts it; a positive adjustment makes it in_stock again", async () => {
    await adjust(rollId, -10, -1);
    expect(await status()).toBe("exhausted");
    await adjust(rollId, 10, 1);
    expect(await status()).toBe("in_stock");
  });

  it("H-06: +10 kg at $5/kg posts a balanced $50 pair (nominal and base)", async () => {
    const ref = await adjust(rollId, 10, 0);
    const legs = await db
      .select({
        t: ledgerEntries.type,
        d: ledgerEntries.debit,
        c: ledgerEntries.credit,
        bd: ledgerEntries.baseDebit,
        bc: ledgerEntries.baseCredit,
      })
      .from(ledgerEntries)
      .where(eq(ledgerEntries.referenceId, ref));
    expect(legs).toHaveLength(2);
    const sum = (f: (l: (typeof legs)[number]) => number) =>
      round2dp(legs.reduce((s, l) => s + f(l), 0));
    expect(sum((l) => Number(l.d) - Number(l.c))).toBe(0);
    expect(sum((l) => Number(l.bd ?? 0) - Number(l.bc ?? 0))).toBe(0);
    expect(sum((l) => Number(l.bd ?? 0))).toBe(50);
    expect(legs.find((l) => l.t === "expense")?.c).toSatisfy((x: unknown) => Number(x) === 50);
  });
});
