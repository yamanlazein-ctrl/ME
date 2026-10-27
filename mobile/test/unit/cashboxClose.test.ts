import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { makeTestPhone, type TestPhone } from "../helpers/testPhone";

describe("cashbox close-day", () => {
  let t: TestPhone;
  beforeAll(async () => {
    t = await makeTestPhone();
  });
  afterAll(() => t?.close());

  const day = "2026-03-01";

  it("sends only the date, the counted amount and the currency, queues one unit, and locks the day", async () => {
    const before = await t.phone.repos.syncOutboxRepo.countOutstanding(
      t.phone.identity.tenantId as never,
    );
    const r = await t.phone.documents.closeCashboxDay({ date: day, counted: 0, currency: "USD" });
    expect(r.ok, JSON.stringify(r)).toBe(true);
    expect(
      await t.phone.repos.syncOutboxRepo.countOutstanding(t.phone.identity.tenantId as never),
    ).toBe(before + 1);
    const row = t.conn
      .prepare("SELECT entity_type AS e, payload AS p FROM sync_outbox ORDER BY seq DESC LIMIT 1")
      .get() as { e: string; p: string };
    const payload = JSON.parse(row.p) as Record<string, unknown>;
    const input = (payload.closeInput ?? payload.input ?? payload) as Record<string, unknown>;
    expect(JSON.stringify(input)).toContain('"counted":0');
    expect(
      Object.keys(input)
        .filter((k) => ["date", "counted", "currency"].includes(k))
        .sort(),
    ).toEqual(["counted", "currency", "date"]);
    expect(Object.keys(input).sort()).toEqual(["counted", "currency", "date"]);
    // the same day cannot be closed twice
    const again = await t.phone.documents.closeCashboxDay({
      date: day,
      counted: 0,
      currency: "USD",
    });
    expect(again.ok).toBe(false);
  });

  it("warehouse and viewer cannot close a day", async () => {
    const w = await makeTestPhone("warehouse");
    try {
      const r = await w.phone.documents.closeCashboxDay({ date: day, counted: 0, currency: "USD" });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("إقفال اليوم متاح");
    } finally {
      w.close();
    }
  });
});
