import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenantTx } from "@backend/infrastructure/orm/engine";
import { createPartyUseCase } from "@backend/application/use-cases/parties/partyUseCases";
import { lastEntryPrice, listFabrics, loadColorLots, loadFabric } from "../../src/core/stock";
import { loadPartyBalances } from "../../src/core/reports";
import { makeTestPhone, type TestPhone } from "../helpers/testPhone";

const colorsOf = async (phone: Parameters<typeof loadFabric>[0], fabricId: string) =>
  (await loadFabric(phone, fabricId))?.colors ?? [];
const lotsOf = async (phone: Parameters<typeof loadColorLots>[0], colorId: string) =>
  (await loadColorLots(phone, colorId))?.lots ?? [];

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
    expect(await listFabrics(t.phone, "قماش جديد")).toHaveLength(0);
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
    expect(await listFabrics(t.phone, "قماش أ")).toHaveLength(0);
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
    const fabrics = await listFabrics(t.phone, "قطن شراء");
    expect(fabrics).toHaveLength(1);
    expect(fabrics[0]).toMatchObject({ remainingKg: 90, activeLots: 3 });
    const colors = await colorsOf(t.phone, fabrics[0]!.id);
    expect(colors.map((c) => [c.name, c.remainingKg])).toEqual([
      ["أحمر", 60],
      ["أزرق", 30],
    ]);
    const rolls = await lotsOf(t.phone, colors[0]!.id);
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
    const fabrics = await listFabrics(t.phone, "قطن شراء");
    expect(fabrics).toHaveLength(1);
    expect(fabrics[0]).toMatchObject({ remainingKg: 95, activeLots: 4 });
    expect(await colorsOf(t.phone, fabrics[0]!.id)).toHaveLength(2);
  });

  it("cancelling a purchase reverses its stock", async () => {
    const list = await t.phone.repos.invoiceRepo.list(
      { type: "entry", limit: 10 } as never,
      t.phone.context(),
    );
    const newest = list.data[0]!;
    const c = await t.phone.documents.cancelInvoice(newest.id, newest.version);
    if (!c.ok) throw new Error(c.error);
    const fabrics = await listFabrics(t.phone, "قطن شراء");
    expect(fabrics[0]!.remainingKg).toBe(90);
  });

  it("keeps every desktop field: line note (gross, كراماج…), discount, lot width/grammage/sale price, colour code, supplier's number", async () => {
    const r = await t.phone.documents.createEntryInvoice({
      ...input([
        {
          fabricName: "قماش التفاصيل",
          colorName: "كحلي",
          colorCode: "NV-3",
          dyeBatch: "DB-77",
          quantityKg: 20,
          pieces: 4,
          pricePerKg: 3,
          discountAmount: 5,
          details: { machineNo: "12", kromaj: "180", draw: "3", grossKg: 21.5 },
          widthCm: 180,
          weightGsm: 210,
          salePricePerKg: 4.25,
        },
      ]),
      reference: "F-501",
      paymentMethod: "transfer",
      paid: 10,
    });
    if (!r.ok) throw new Error(r.error);
    const inv = r.data;
    expect(inv.lines[0]).toMatchObject({ quantityKg: 20, discountAmount: 5 });
    expect(inv.lines[0]!.note).toBe("رقم الماكينة: 12 • كراماج: 180 • السحب: 3 • وزن قائم: 21.5");
    expect(Number(inv.total)).toBe(55);
    expect(inv).toMatchObject({ reference: "F-501", paymentMethod: "transfer" });
    expect(inv.notes).toBe("المرجع: F-501 • طريقة الدفع: تحويل بنكي");
    const ctx = t.phone.context();
    const roll = await t.phone.repos.rollRepo.findById(inv.lines[0]!.rollId, ctx);
    expect(roll).toMatchObject({ dyeBatch: "DB-77", pieces: 4 });
    expect(Number(roll!.widthCm)).toBe(180);
    expect(Number(roll!.weightGsm)).toBe(210);
    expect(Number(roll!.salePricePerKg)).toBe(4.25);
    const color = await t.phone.repos.colorRepo.findById(roll!.colorId, ctx);
    expect(color).toMatchObject({ name: "كحلي", code: "NV-3" });
  });

  it("«آخر سعر» is the newest purchase price of the colour in that currency, not a cancelled one", async () => {
    const buy = async (price: number) => {
      const r = await t.phone.documents.createEntryInvoice({
        ...input([
          {
            fabricName: "قماش السعر",
            colorName: "رمادي",
            quantityKg: 5,
            pieces: 1,
            pricePerKg: price,
          },
        ]),
      });
      if (!r.ok) throw new Error(r.error);
      return r.data;
    };
    await buy(3);
    const second = await buy(4);
    const fabric = (await listFabrics(t.phone, "قماش السعر"))[0]!;
    const colorId = (await colorsOf(t.phone, fabric.id))[0]!.id;
    expect(await lastEntryPrice(t.phone, { colorId }, "USD")).toMatchObject({
      pricePerKg: 4,
      date: today,
    });
    expect(await lastEntryPrice(t.phone, { colorId }, "SYP")).toBeNull();
    const c = await t.phone.documents.cancelInvoice(second.id, second.version);
    if (!c.ok) throw new Error(c.error);
    expect((await lastEntryPrice(t.phone, { colorId }, "USD"))?.pricePerKg).toBe(3);
  });
});
