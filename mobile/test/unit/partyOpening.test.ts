import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadFullStatement } from "../../src/core/partyQueries";
import { partyBalances } from "../../src/core/parties";
import { loadPartyBalances } from "../../src/core/reports";
import { makeTestPhone, type TestPhone } from "../helpers/testPhone";

describe("party opening balance on a new party (T127)", () => {
  let t: TestPhone;
  const today = new Date().toISOString().slice(0, 10);
  beforeAll(async () => {
    t = await makeTestPhone();
    await t.giveBlock("supplier", "SUP");
    await t.giveBlock("customer", "CUS");
  });
  afterAll(() => t?.close());

  const open = async (
    kind: "customer" | "supplier",
    name: string,
    direction: string,
    amount = 1000,
  ) => {
    const r = await t.phone.documents.createParty(kind, {
      name,
      openingAmount: amount,
      openingDirection: direction,
      openingCurrency: "USD",
      openingDate: today,
    });
    if (!r.ok) throw new Error(r.error);
    return r.data;
  };

  it("a supplier we owe 1,000 USD starts the statement at +1,000; one that owes us starts at -1,000", async () => {
    const owed = await open("supplier", "مورد له", "we_owe_them");
    const credit = await open("supplier", "مورد عليه", "they_owe_us");
    const a = await loadFullStatement(t.phone, {
      partyId: owed.id,
      kind: "supplier",
      currency: "USD",
    });
    const b = await loadFullStatement(t.phone, {
      partyId: credit.id,
      kind: "supplier",
      currency: "USD",
    });
    expect(a.header.finalBalance).toBe(1000);
    expect(b.header.finalBalance).toBe(-1000);
    expect(a.entries.length).toBeGreaterThan(0);
  });

  it("balances list every currency of the party, not only the party's own (the desktop's ALL)", async () => {
    const supplier = await open("supplier", "مورد دولار", "we_owe_them", 250);
    expect(await partyBalances(t.phone, supplier.id, "supplier")).toEqual([
      expect.objectContaining({ currency: "USD", balance: 250, side: "credit" }),
    ]);
  });

  it("a customer who owes us 500 shows in the customer balances", async () => {
    await open("customer", "عميل افتتاحي", "they_owe_us", 500);
    const bal = await loadPartyBalances(t.phone, "customer");
    expect(bal).toEqual([
      expect.objectContaining({ name: "عميل افتتاحي", remaining: 500, currency: "USD" }),
    ]);
  });

  it("queues the opening in the party's create unit", async () => {
    const row = t.conn
      .prepare(
        "SELECT payload AS p FROM sync_outbox WHERE entity_type = 'party' ORDER BY seq DESC LIMIT 1",
      )
      .get() as { p: string };
    const payload = JSON.parse(row.p) as {
      createInput?: Record<string, unknown>;
      snapshot?: Record<string, unknown>;
    };
    expect(JSON.stringify(payload)).toContain('"openingBalance":500');
  });
});
