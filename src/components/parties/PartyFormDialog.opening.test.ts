/**
 * Opening-balance form mapping: له/لنا ↔ signed SoT per party kind, and an
 * edit sends `opening` only when the balance section actually changed.
 */
import { describe, it, expect } from "vitest";
import { fromParty, toPatch, type SimpleParty } from "./PartyFormDialog";

const party = (over: Partial<SimpleParty>): SimpleParty => ({
  id: "p1",
  name: "X",
  currency: "SYP",
  ...over,
});

describe("PartyFormDialog opening mapping", () => {
  it("create: لنا is positive for a customer, له is positive for a supplier", () => {
    const c = fromParty(party({}), "customer");
    expect(toPatch({ ...c, openingAmount: "50", openingDirection: "they_owe_us" }, "customer", undefined).openingBalance).toBe(50);
    expect(toPatch({ ...c, openingAmount: "50", openingDirection: "we_owe_them" }, "customer", undefined).openingBalance).toBe(-50);
    const s = fromParty(party({}), "supplier");
    expect(toPatch({ ...s, openingAmount: "50", openingDirection: "we_owe_them" }, "supplier", undefined).openingBalance).toBe(50);
    expect(toPatch({ ...s, openingAmount: "50", openingDirection: "they_owe_us" }, "supplier", undefined).openingBalance).toBe(-50);
  });

  it("edit round-trips a negative supplier balance in its own currency without sending opening", () => {
    const p = party({ openingBalance: -30, openingCurrency: "USD", openingDate: "2026-01-02" });
    const d = fromParty(p, "supplier");
    expect(d).toMatchObject({ openingAmount: "30", openingDirection: "they_owe_us", openingCurrency: "USD" });
    expect(toPatch(d, "supplier", p).opening).toBeUndefined();
  });

  it("edit sends opening when the amount changes", () => {
    const p = party({ openingBalance: 30, openingDate: "2026-01-02" });
    const out = toPatch({ ...fromParty(p, "customer"), openingAmount: "45" }, "customer", p);
    expect(out.opening).toEqual({
      amount: 45,
      direction: "they_owe_us",
      currency: "SYP",
      date: "2026-01-02",
      note: null,
    });
    expect(out.openingBalance).toBeUndefined();
  });
});
