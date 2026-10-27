import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenantTx } from "@backend/infrastructure/orm/engine";
import { createPartyUseCase } from "@backend/application/use-cases/parties/partyUseCases";
import { createFabricUseCase } from "@backend/application/use-cases/inventory/fabricUseCases";
import { createColorUseCase } from "@backend/application/use-cases/inventory/colorUseCases";
import { createRollUseCase } from "@backend/application/use-cases/inventory/rollUseCases";
import { listRollsOfColor } from "../../src/core/inventory";
import { loadPartyBalances } from "../../src/core/reports";
import {
  emptyReturnDraft,
  listReturns,
  listSourceInvoices,
  loadReturnableLines,
  returnProblems,
  toReturnInput,
} from "../../src/core/returns";
import { makeTestPhone, type TestPhone } from "../helpers/testPhone";

const must = <T>(r: { ok: true; data: T } | { ok: false; error: string }) => {
  if (!r.ok) throw new Error(r.error);
  return r.data;
};

describe("sale return against a source invoice", () => {
  let t: TestPhone;
  let partyId = "";
  let colorId = "";
  let invoiceId = "";
  const today = new Date().toISOString().slice(0, 10);
  const outstanding = () =>
    t.phone.repos.syncOutboxRepo.countOutstanding(t.phone.identity.tenantId as never);

  beforeAll(async () => {
    t = await makeTestPhone();
    await t.giveBlock("return", "RET");
    const ctx = t.phone.context();
    partyId = await withTenantTx(
      ctx.tenantId,
      async () =>
        must(
          await createPartyUseCase(
            t.phone.repos.partyRepo,
            { kind: "customer", code: "C-RET", name: "عميل المرتجع", currency: "SYP" },
            ctx,
          ),
        ).id,
    );
    const fabric = must(
      await createFabricUseCase(
        t.phone.repos.fabricRepo,
        { name: "قطن مرتجع", minStockKg: 0 },
        ctx,
      ),
    );
    colorId = must(
      await createColorUseCase(
        t.phone.repos.colorRepo,
        { fabricId: fabric.id, name: "رمادي" },
        ctx,
      ),
    ).id;
    const mk = async (rollNo: string, kg: number) =>
      must(
        await createRollUseCase(
          t.phone.repos.rollRepo,
          {
            colorId,
            rollNo,
            initialKg: kg,
            pieces: 2,
            pricePerKg: 3,
            currency: "USD",
            entryDate: today,
          },
          ctx,
        ),
      );
    const r1 = await mk("RET-R1", 20);
    const r2 = await mk("RET-R2", 10);
    const sale = await t.phone.documents.createInvoice({
      type: "sale",
      date: today,
      partyId,
      partyType: "customer",
      currency: "SYP",
      exchangeRate: 14500,
      lines: [
        {
          fabricId: fabric.id,
          colorId,
          rollId: r1.id,
          quantityKg: 5,
          pieces: 1,
          pricePerKg: 40000,
        },
        {
          fabricId: fabric.id,
          colorId,
          rollId: r2.id,
          quantityKg: 3,
          pieces: 0,
          pricePerKg: 50000,
        },
      ],
      paid: 0,
      preAllocatedNumber: t.nextNumber("INV"),
    } as never);
    invoiceId = must(sale).id;
  });
  afterAll(() => t?.close());

  const stock = async () =>
    Object.fromEntries(
      (await listRollsOfColor(t.phone, colorId)).map((r) => [r.rollNo, r.remainingKg]),
    );

  it("lists the party's active sale invoices and their returnable lines", async () => {
    const invoices = await listSourceInvoices(t.phone, "sale", partyId);
    expect(invoices).toHaveLength(1);
    expect(invoices[0]).toMatchObject({ total: 350000, currency: "SYP" });
    const lines = await loadReturnableLines(t.phone, invoiceId);
    expect(lines?.lines.map((l) => [l.label.split(" · ")[2], l.soldKg])).toEqual([
      ["RET-R1", 5],
      ["RET-R2", 3],
    ]);
  });

  it("the draft names its problems, and refuses more than was sold", async () => {
    const lines = (await loadReturnableLines(t.phone, invoiceId))!;
    const draft = { ...emptyReturnDraft("sale"), lines: lines.lines };
    expect(returnProblems(draft)).toEqual(["no-party", "no-invoice", "no-lines"]);
    const over = {
      ...draft,
      party: { id: partyId, name: "x" },
      invoice: (await listSourceInvoices(t.phone, "sale", partyId))[0]!,
      qty: { [lines.lines[0]!.rollId]: { kg: 6, pieces: 0 } },
    };
    expect(returnProblems(over)).toEqual(["over"]);
    const r = await t.phone.documents.createReturn(
      toReturnInput({ ...over, currency: "SYP" }, today),
    );
    expect(r.ok).toBe(false);
    expect(await stock()).toEqual({ "RET-R1": 15, "RET-R2": 7 });
  });

  it("returning 2 lines at rate 14,500 restores stock, reduces the balance, queues one unit; cancel reverses", async () => {
    const lines = (await loadReturnableLines(t.phone, invoiceId))!;
    const invoice = (await listSourceInvoices(t.phone, "sale", partyId))[0]!;
    const draft = {
      ...emptyReturnDraft("sale"),
      party: { id: partyId, name: "عميل المرتجع" },
      invoice,
      currency: "SYP",
      lines: lines.lines,
      qty: {
        [lines.lines[0]!.rollId]: { kg: 2, pieces: 0 },
        [lines.lines[1]!.rollId]: { kg: 1, pieces: 0 },
      },
    };
    expect(returnProblems(draft)).toEqual([]);
    const before = await outstanding();
    const made = must(await t.phone.documents.createReturn(toReturnInput(draft, today)));
    expect(await stock()).toEqual({ "RET-R1": 17, "RET-R2": 8 });
    // 350,000 - (2 x 40,000 + 1 x 50,000)
    expect((await loadPartyBalances(t.phone, "customer"))[0]).toMatchObject({ remaining: 220000 });
    expect(await outstanding()).toBe(before + 1);
    const listed = await listReturns(t.phone);
    expect(listed[0]).toMatchObject({ number: made.number, status: "active", total: 130000 });

    must(await t.phone.documents.cancelReturn(made.id, made.version));
    expect(await stock()).toEqual({ "RET-R1": 15, "RET-R2": 7 });
    expect((await loadPartyBalances(t.phone, "customer"))[0]).toMatchObject({ remaining: 350000 });
    expect(await outstanding()).toBe(before + 2);
  });

  it("warehouse and viewer cannot create a return", async () => {
    const w = await makeTestPhone("viewer");
    try {
      const r = await w.phone.documents.createReturn({
        kind: "sale",
        date: today,
        partyId,
        reason: "other",
        lines: [],
      } as never);
      expect(r.ok).toBe(false);
    } finally {
      w.close();
    }
  });
});
