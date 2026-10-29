import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenantTx } from "@backend/infrastructure/orm/engine";
import { createPartyUseCase } from "@backend/application/use-cases/parties/partyUseCases";
import { listColorStock, listFabricStock, listRollsOfColor } from "../../src/core/inventory";
import { loadPartyBalances } from "../../src/core/reports";
import { makeTestPhone, type TestPhone } from "../helpers/testPhone";

describe("purchase (entry) invoice: new colours and rolls in the same save", () => {
  let t: TestPhone;
  let supplierId = "";
  const today = new Date().toISOString().slice(0, 10);
  const outstanding = () =>
    t.phone.repos.syncOutboxRepo.countOutstanding(t.phone.identity.tenantId as never);

  beforeAll(async () => {
    t = await makeTestPhone();
    await t.giveBlock("invoice_entry", "ENT");
    const ctx = t.phone.context();
    supplierId = await withTenantTx(ctx.tenantId, async () => {
      const r = await createPartyUseCase(
        t.phone.repos.partyRepo,
        { kind: "supplier", code: "S-1", name: "مورد الشراء", currency: "USD" },
        ctx,
      );
      if (!r.ok) throw new Error(r.error);
      return r.data.id;
    });
  });
  afterAll(() => t?.close());

  const input = (lines: Array<Record<string, unknown>>) => ({
    date: today,
    supplierId,
    currency: "USD",
    exchangeRate: 1,
    paid: 0,
    lines: lines as never,
  });

  it("a failure after the colour insert leaves no fabric, colour, roll, ledger row or sync unit", async () => {
    const before = await outstanding();
    const r = await t.phone.documents.createEntryInvoice({
      ...input([
        {
          fabricName: "قماش جديد",
          colorName: "لون جديد",
          quantityKg: 10,
          pieces: 1,
          pricePerKg: 2,
        },
      ]),
      supplierId: "00000000-0000-4000-8000-000000000000", // the invoice use-case refuses an unknown supplier
    });
    expect(r.ok).toBe(false);
    expect(await listFabricStock(t.phone, "قماش جديد")).toHaveLength(0);
    expect(await outstanding()).toBe(before);
    expect(await loadPartyBalances(t.phone, "supplier")).toEqual([]);
  });

  it("a bad second line rolls back the first line's new fabric, colour and roll", async () => {
    const before = await outstanding();
    const r = await t.phone.documents.createEntryInvoice(
      input([
        { fabricName: "قماش أ", colorName: "أحمر", quantityKg: 5, pieces: 1, pricePerKg: 2 },
        { fabricName: "قماش أ", colorName: "أزرق", quantityKg: 0, pieces: 1, pricePerKg: 2 },
      ]),
    );
    expect(r.ok).toBe(false);
    expect(await listFabricStock(t.phone, "قماش أ")).toHaveLength(0);
    expect(await outstanding()).toBe(before);
  });

  it("saves 1 fabric, 2 colours and 3 rolls with the invoice; stock, supplier balance and sync units follow", async () => {
    const before = await outstanding();
    const r = await t.phone.documents.createEntryInvoice(
      input([
        { fabricName: "قطن شراء", colorName: "أحمر", quantityKg: 40, pieces: 2, pricePerKg: 2.5 },
        { fabricName: "قطن شراء", colorName: "أزرق", quantityKg: 30, pieces: 1, pricePerKg: 3 },
        { fabricName: "قطن شراء", colorName: "أحمر", quantityKg: 20, pieces: 1, pricePerKg: 2.5 },
      ]),
    );
    if (!r.ok) throw new Error(r.error);
    expect(r.data.type).toBe("entry");
    expect(r.data.total).toBe(40 * 2.5 + 30 * 3 + 20 * 2.5);
    const fabrics = await listFabricStock(t.phone, "قطن شراء");
    expect(fabrics).toHaveLength(1);
    expect(fabrics[0]).toMatchObject({ remainingKg: 90, rollCount: 3 });
    const colors = await listColorStock(t.phone, fabrics[0]!.id);
    expect(colors.map((c) => [c.name, c.remainingKg])).toEqual([
      ["أحمر", 60],
      ["أزرق", 30],
    ]);
    const rolls = await listRollsOfColor(t.phone, colors[0]!.id);
    expect(rolls.map((x) => x.remainingKg).sort()).toEqual([20, 40]);
    const bal = await loadPartyBalances(t.phone, "supplier");
    expect(bal[0]).toMatchObject({ name: "مورد الشراء", currency: "USD", remaining: 240 });
    // 1 fabric + 2 colours + 3 rolls + 1 invoice
    expect(await outstanding()).toBe(before + 7);
  });

  it("a second purchase of the same fabric and colour reuses them", async () => {
    const r = await t.phone.documents.createEntryInvoice(
      input([
        { fabricName: " قطن  شراء ", colorName: "أزرق", quantityKg: 5, pieces: 1, pricePerKg: 3 },
      ]),
    );
    if (!r.ok) throw new Error(r.error);
    const fabrics = await listFabricStock(t.phone, "قطن شراء");
    expect(fabrics).toHaveLength(1);
    expect(fabrics[0]).toMatchObject({ remainingKg: 95, rollCount: 4 });
    expect(await listColorStock(t.phone, fabrics[0]!.id)).toHaveLength(2);
  });

  it("cancelling a purchase reverses its stock", async () => {
    const list = await t.phone.repos.invoiceRepo.list(
      { type: "entry", limit: 10 } as never,
      t.phone.context(),
    );
    const newest = list.data[0]!;
    const c = await t.phone.documents.cancelInvoice(newest.id, newest.version);
    if (!c.ok) throw new Error(c.error);
    const fabrics = await listFabricStock(t.phone, "قطن شراء");
    expect(fabrics[0]!.remainingKg).toBe(90);
  });
});
