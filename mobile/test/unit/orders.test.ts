import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenantTx } from "@backend/infrastructure/orm/engine";
import { createPartyUseCase } from "@backend/application/use-cases/parties/partyUseCases";
import { createFabricUseCase } from "@backend/application/use-cases/inventory/fabricUseCases";
import { createColorUseCase } from "@backend/application/use-cases/inventory/colorUseCases";
import { createRollUseCase } from "@backend/application/use-cases/inventory/rollUseCases";
import { isOrderActive, listFulfilCandidates, listOrders, loadOrder } from "../../src/core/orders";
import { makeTestPhone, type TestPhone } from "../helpers/testPhone";

const must = <T>(r: { ok: true; data: T } | { ok: false; error: string }) => {
  if (!r.ok) throw new Error(r.error);
  return r.data;
};

describe("orders", () => {
  let t: TestPhone;
  let customerId = "";
  let fabricId = "";
  let colorId = "";
  const today = new Date().toISOString().slice(0, 10);
  const outstanding = () =>
    t.phone.repos.syncOutboxRepo.countOutstanding(t.phone.identity.tenantId as never);

  beforeAll(async () => {
    t = await makeTestPhone();
    await t.giveBlock("order", "ORD");
    const ctx = t.phone.context();
    customerId = await withTenantTx(
      ctx.tenantId,
      async () =>
        must(
          await createPartyUseCase(
            t.phone.repos.partyRepo,
            { kind: "customer", code: "C-ORD", name: "عميل الطلب", currency: "USD" },
            ctx,
          ),
        ).id,
    );
    fabricId = must(
      await createFabricUseCase(t.phone.repos.fabricRepo, { name: "قطن طلب", minStockKg: 0 }, ctx),
    ).id;
    colorId = must(
      await createColorUseCase(t.phone.repos.colorRepo, { fabricId, name: "بني" }, ctx),
    ).id;
  });
  afterAll(() => t?.close());

  const order = (name: string, kg: number) => ({
    customerId,
    customerNameSnapshot: name,
    date: today,
    currency: "USD",
    items: [{ fabricId, fabricName: "قطن طلب", colorId, colorName: "بني", requestedKg: kg }],
  });

  it("creates an order with a code from the device block and one sync unit", async () => {
    const before = await outstanding();
    const o = must(await t.phone.documents.createOrder(order("عميل الطلب", 50)));
    expect(o.code).toMatch(/^ORD-/);
    expect(o.status).toBe("open");
    expect(await outstanding()).toBe(before + 1);
    expect(await listOrders(t.phone)).toEqual([
      expect.objectContaining({
        code: o.code,
        customer: "عميل الطلب",
        totalKg: 50,
        status: "open",
      }),
    ]);
  });

  it("refuses an order with no customer name or no items", async () => {
    expect((await t.phone.documents.createOrder({ ...order("", 5) })).ok).toBe(false);
    expect((await t.phone.documents.createOrder({ ...order("x", 5), items: [] })).ok).toBe(false);
  });

  it("shows the other open order for the same fabric and colour as a pending conflict", async () => {
    const second = must(await t.phone.documents.createOrder(order("عميل ثانٍ", 20)));
    const detail = await loadOrder(t.phone, second.id);
    expect(detail?.conflicts).toHaveLength(1);
    expect(detail?.conflicts[0]).toMatchObject({ customer: "عميل الطلب" });
  });

  it("cancels an open order (one more unit), and a cancelled order is not cancelled twice", async () => {
    const list = await listOrders(t.phone);
    const target = list.find((o) => o.customer === "عميل ثانٍ")!;
    const before = await outstanding();
    must(await t.phone.documents.cancelOrder(target.id, target.version));
    expect(await outstanding()).toBe(before + 1);
    expect((await loadOrder(t.phone, target.id))?.order.status).toBe("cancelled");
    expect((await t.phone.documents.cancelOrder(target.id, target.version + 1)).ok).toBe(false);
  });

  it("fulfils an open order with an invoice of the customer", async () => {
    const roll = must(
      await createRollUseCase(
        t.phone.repos.rollRepo,
        {
          colorId,
          rollNo: "ORD-R1",
          initialKg: 100,
          pieces: 1,
          pricePerKg: 2,
          currency: "USD",
          entryDate: today,
        },
        t.phone.context(),
      ),
    );
    const sale = must(
      await t.phone.documents.createInvoice({
        type: "sale",
        date: today,
        partyId: customerId,
        partyType: "customer",
        currency: "USD",
        exchangeRate: 1,
        lines: [{ fabricId, colorId, rollId: roll.id, quantityKg: 5, pieces: 0, pricePerKg: 4 }],
        paid: 0,
        preAllocatedNumber: t.nextNumber("INV"),
      } as never),
    );
    const candidates = await listFulfilCandidates(t.phone, customerId);
    expect(candidates.map((c) => c.id)).toEqual([sale.id]);
    const open = (await listOrders(t.phone)).find((o) => isOrderActive(o.status))!;
    must(await t.phone.documents.fulfillOrder(open.id, sale.id));
    const after = await loadOrder(t.phone, open.id);
    expect(after?.order.status).toBe("fulfilled");
    expect(after?.order.fulfilledInvoiceId).toBe(sale.id);
  });
});
