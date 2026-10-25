import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cashboxBalanceAt, cashboxBalances, cashboxMovementsOn } from "../../src/core/cashbox";
import { makeTestPhone, type TestPhone } from "../helpers/testPhone";

describe("cashbox reads (FR-23)", () => {
  let t: TestPhone;
  beforeAll(async () => {
    t = await makeTestPhone();
  });
  afterAll(() => t?.close());

  it("a manual movement dated yesterday changes yesterday's and today's balances, not the day before", async () => {
    const added = await t.phone.documents.addCashboxMovement({
      date: "2026-03-01",
      type: "capital",
      direction: "in",
      amount: 100,
      currency: "USD",
      description: "test",
    });
    expect(added.ok, JSON.stringify(added)).toBe(true);
    expect(await cashboxBalanceAt(t.phone, "2026-02-28", "USD")).toBe(0);
    expect(await cashboxBalanceAt(t.phone, "2026-03-01", "USD")).toBe(100);
    expect(await cashboxBalanceAt(t.phone, "2026-03-02", "USD")).toBe(100);
    expect((await cashboxBalances(t.phone, "2026-03-02")).USD).toBe(100);
    expect(await cashboxMovementsOn(t.phone, "2026-03-01", "USD")).toEqual({ in: 100, out: 0 });
    // The movement is queued for the hub as one unit.
    const outstanding = await t.phone.repos.syncOutboxRepo.countOutstanding(
      t.phone.identity.tenantId as never,
    );
    expect(outstanding).toBe(1);
  });

  it("refuses a zero amount", async () => {
    const r = await t.phone.documents.addCashboxMovement({
      date: "2026-03-01",
      type: "capital",
      direction: "in",
      amount: 0,
      currency: "USD",
    });
    expect(r.ok).toBe(false);
  });
});
