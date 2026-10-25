import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenantTx } from "@backend/infrastructure/orm/engine";
import { createPartyUseCase } from "@backend/application/use-cases/parties/partyUseCases";
import { loadFullStatement, searchParties, sortByRecent } from "../../src/core/partyQueries";
import { makeTestPhone, type TestPhone } from "../helpers/testPhone";

describe("party search and statement (FR-11, FR-13)", () => {
  let t: TestPhone;
  let customerId = "";

  beforeAll(async () => {
    t = await makeTestPhone();
    const ctx = t.phone.context();
    await withTenantTx(ctx.tenantId, async () => {
      for (let i = 0; i < 2000; i++) {
        const r = await createPartyUseCase(
          t.phone.repos.partyRepo,
          {
            kind: i % 5 === 0 ? "supplier" : "customer",
            code: `P-${String(i).padStart(5, "0")}`,
            name: i === 777 ? "Zeinab Fabrics" : `Party ${i}`,
            currency: "USD",
          },
          ctx,
        );
        if (!r.ok) throw new Error(r.error);
        if (i === 1) customerId = r.data.id;
      }
    });
  }, 300_000);

  afterAll(() => t?.close());

  it("three letters on 2,000 parties return within 150 ms (NFR-02 proxy)", async () => {
    await searchParties(t.phone, { q: "zei" }); // warm the statement cache
    const started = performance.now();
    const rows = await searchParties(t.phone, { q: "zei" });
    const elapsed = performance.now() - started;
    expect(rows.map((r) => r.name)).toEqual(["Zeinab Fabrics"]);
    expect(elapsed).toBeLessThan(150);
  });

  it("filters by kind and caps the page at the limit", async () => {
    const customers = await searchParties(t.phone, { q: "Party", kind: "customer", limit: 20 });
    expect(customers).toHaveLength(20);
    expect(customers.every((r) => r.kind === "customer")).toBe(true);
  });

  it("recently used parties come first, the others keep their order", () => {
    const rows = [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }];
    expect(sortByRecent(rows, ["c", "a"]).map((r) => r.id)).toEqual(["c", "a", "b", "d"]);
  });

  it("a 650-row statement loads every row and ends on the use-case's closing balance", async () => {
    for (let i = 0; i < 650; i++) {
      const r = await t.phone.documents.createVoucher("receipt", {
        date: "2026-02-01",
        partyId: customerId,
        partyKind: "customer",
        amount: 1 + (i % 7),
        currency: "USD",
        exchangeRate: 1,
        method: "cash",
        preAllocatedNumber: t.nextNumber("VOC"),
      });
      if (!r.ok) throw new Error(r.error);
    }
    const full = await loadFullStatement(t.phone, {
      partyId: customerId,
      kind: "customer",
      currency: "USD",
    });
    expect(full.entries).toHaveLength(650);
    const last = full.entries.at(-1);
    expect(last?.runningBalance).toBe(full.header.finalBalance);
  }, 300_000);
});
