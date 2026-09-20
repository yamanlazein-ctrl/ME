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
  });
});
