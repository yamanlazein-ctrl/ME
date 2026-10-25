import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenantTx } from "@backend/infrastructure/orm/engine";
import { createPartyUseCase } from "@backend/application/use-cases/parties/partyUseCases";
import { createFabricUseCase } from "@backend/application/use-cases/inventory/fabricUseCases";
import { createColorUseCase } from "@backend/application/use-cases/inventory/colorUseCases";
import { createRollUseCase } from "@backend/application/use-cases/inventory/rollUseCases";
import { loadInvoiceView, toPrintData } from "../../src/core/invoiceView";
import { pickColors, pickFabrics, pickRolls } from "../../src/core/inventoryPicker";
import { renderInvoiceHtml } from "../../src/print/renderHtml";
import { makeTestPhone, type TestPhone } from "../helpers/testPhone";

describe("invoice detail data, roll picker lookups and PDF html", () => {
  let t: TestPhone;
  let invoiceId = "";
  beforeAll(async () => {
    t = await makeTestPhone();
    const ctx = t.phone.context();
    const must = <T>(r: { ok: true; data: T } | { ok: false; error: string }) => {
      if (!r.ok) throw new Error(r.error);
      return r.data;
    };
    const party = await withTenantTx(ctx.tenantId, async () =>
      must(
        await createPartyUseCase(
          t.phone.repos.partyRepo,
          { kind: "customer", code: "C-9", name: "عميل الفاتورة", currency: "USD" },
          ctx,
        ),
      ),
    );
    const fabric = must(
      await createFabricUseCase(t.phone.repos.fabricRepo, { name: "قطن", minStockKg: 0 }, ctx),
    );
    const color = must(
      await createColorUseCase(t.phone.repos.colorRepo, { fabricId: fabric.id, name: "أبيض" }, ctx),
    );
    const roll = must(
      await createRollUseCase(
        t.phone.repos.rollRepo,
        {
          colorId: color.id,
          rollNo: "R-77",
          initialKg: 100,
          pieces: 5,
          pricePerKg: 3,
          currency: "USD",
          entryDate: "2026-03-01",
        },
        ctx,
      ),
    );
    const sale = await t.phone.documents.createInvoice({
      type: "sale",
      date: "2026-03-01",
      partyId: party.id,
      partyType: "customer",
      currency: "USD",
      exchangeRate: 1,
      lines: [
        {
          fabricId: fabric.id,
          colorId: color.id,
          rollId: roll.id,
          quantityKg: 12.5,
          pieces: 0,
          pricePerKg: 4,
        },
      ],
      paid: 10,
      preAllocatedNumber: t.nextNumber("INV"),
    } as never);
    if (!sale.ok) throw new Error(sale.error);
    invoiceId = sale.data.id;
  });
  afterAll(() => t?.close());

  it("loads names and roll numbers, and builds the same html the archive prints", async () => {
    const view = await loadInvoiceView(t.phone, invoiceId);
    expect(view?.partyName).toBe("عميل الفاتورة");
    expect(view?.lines[0]).toMatchObject({
      fabric: "قطن",
      color: "أبيض",
      rollNo: "R-77",
      lineTotal: 50,
    });
    const html = renderInvoiceHtml(toPrintData(view!));
    expect(html).toContain(view!.invoice.number);
    expect(html).toContain("عميل الفاتورة");
  });

  it("the picker walks fabric → colour → roll with the remaining kg", async () => {
    const fabrics = await pickFabrics(t.phone, "");
    expect(fabrics.map((f) => f.name)).toContain("قطن");
    const colors = await pickColors(t.phone, fabrics[0]!.id);
    const rolls = await pickRolls(t.phone, colors[0]!.id);
    expect(rolls[0]).toMatchObject({ rollNo: "R-77", remainingKg: 87.5 });
  });

  it("cancelling reverses the stock and marks the invoice cancelled", async () => {
    const before = (await loadInvoiceView(t.phone, invoiceId))!;
    const result = await t.phone.documents.cancelInvoice(invoiceId, before.invoice.version);
    expect(result.ok, JSON.stringify(result)).toBe(true);
    expect((await loadInvoiceView(t.phone, invoiceId))?.invoice.status).toBe("cancelled");
    const colors = await pickColors(t.phone, (await pickFabrics(t.phone, ""))[0]!.id);
    expect((await pickRolls(t.phone, colors[0]!.id))[0]?.remainingKg).toBe(100);
  });
});
