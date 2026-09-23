import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

describe("cashbox daily balance migration contract", () => {
  it("ships apply/shift helpers and ledger+manual triggers", () => {
    const sql = readFileSync(
      resolve(HERE, "../src/infrastructure/orm/migrations/20260928_cashbox_daily_balances.sql"),
      "utf8",
    );
    expect(sql).toContain("CREATE TABLE IF NOT EXISTS cashbox_daily_balances");
    expect(sql).toContain("cashbox_daily_apply_delta");
    expect(sql).toContain("cashbox_daily_shift_all");
    expect(sql).toContain("trg_cashbox_daily_from_ledger");
    expect(sql).toContain("trg_cashbox_daily_from_manual");
    expect(sql).toContain("SET row_security = off");
  });

  it("helper exports fast path and full recompute", async () => {
    const mod = await import("../src/infrastructure/repositories/cashboxBalanceHelper.js");
    expect(typeof mod.getCashboxBalanceAsOf).toBe("function");
    expect(typeof mod.recomputeCashboxBalanceAsOf).toBe("function");
    expect(typeof mod.applyCashboxDailyDelta).toBe("function");
    expect(typeof mod.assertSufficientCashboxBalance).toBe("function");
  }, 15_000);

  it("assertSufficientCashboxBalance never queries the DB for a non-positive amount", async () => {
    // Zero/negative cash portion (pure discount settlement) must not touch the DB.
    const { assertSufficientCashboxBalance } = await import(
      "../src/infrastructure/repositories/cashboxBalanceHelper.js"
    );
    const poisonedTx = {
      execute: () => {
        throw new Error("must not touch the DB for a non-positive amount");
      },
      select: () => {
        throw new Error("must not touch the DB for a non-positive amount");
      },
    } as never;
    const ctx = { tenantId: "t1", userId: "u1" } as never;

    await expect(
      assertSufficientCashboxBalance(poisonedTx, ctx, "USD", "2026-09-22", 0),
    ).resolves.toEqual({ available: 0, wouldGoNegative: false });
    await expect(
      assertSufficientCashboxBalance(poisonedTx, ctx, "USD", "2026-09-22", -5),
    ).resolves.toEqual({ available: 0, wouldGoNegative: false });
  });

  it("helper source no longer hard-blocks negative cash balances", async () => {
    const src = readFileSync(
      resolve(HERE, "../src/infrastructure/repositories/cashboxBalanceHelper.ts"),
      "utf8",
    );
    expect(src).toMatch(/Negative cash balances are[\s*]+allowed/);
    expect(src).not.toMatch(/throw new InsufficientCashboxBalanceError/);
  });
});
