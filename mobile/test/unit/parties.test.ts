// The party page's numbers must be the accounting's: a sale, a receipt, a payment and a return move the balance per
// currency exactly as the statement does, and the statement for a period starts from the previous balance.
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenantTx } from "@backend/infrastructure/orm/engine";
import { createPartyUseCase } from "@backend/application/use-cases/parties/partyUseCases";
import { createFabricUseCase } from "@backend/application/use-cases/inventory/fabricUseCases";
import { createColorUseCase } from "@backend/application/use-cases/inventory/colorUseCases";
import { createRollUseCase } from "@backend/application/use-cases/inventory/rollUseCases";
import {
  balanceSideLabel,
  listParties,
  loadPartyProfile,
  loadStatement,
  partyBalances,
  partyDocuments,
  STATEMENT_TYPE_LABEL,
} from "../../src/core/parties";
import {
  loadReturnableLines,
  listSourceInvoices,
  toReturnInput,
  emptyReturnDraft,
} from "../../src/core/returns";
import { makeTestPhone, type TestPhone } from "../helpers/testPhone";

const must = <T>(r: { ok: true; data: T } | { ok: false; error: string }) => {
  if (!r.ok) throw new Error(r.error);
  return r.data;
};

describe("parties: list, balances, documents, statement", () => {
  let t: TestPhone;
  let customer = "";
  let supplier = "";

  beforeAll(async () => {
    t = await makeTestPhone();
    await t.giveBlock("return", "RET");
    const ctx = t.phone.context();
    customer = await withTenantTx(
      ctx.tenantId,
      async () =>
        must(
          await createPartyUseCase(
            t.phone.repos.partyRepo,
            {
              kind: "customer",
              code: "C-9",
              name: "محل النور",
              mobile: "0933 123 456",
              currency: "USD",
            } as never,
            ctx,
          ),
        ).id,
    );
    supplier = await withTenantTx(
      ctx.tenantId,
      async () =>
        must(
          await createPartyUseCase(
            t.phone.repos.partyRepo,
            { kind: "supplier", code: "S-1", name: "معمل الشرق", currency: "USD" },
            ctx,
          ),
        ).id,
    );
    const fabric = must(
      await createFabricUseCase(t.phone.repos.fabricRepo, { name: "قطن", minStockKg: 0 }, ctx),
    );
    const colorId = must(
      await createColorUseCase(t.phone.repos.colorRepo, { fabricId: fabric.id, name: "أبيض" }, ctx),
    ).id;
    const roll = must(
      await createRollUseCase(
        t.phone.repos.rollRepo,
        {
          colorId,
          rollNo: "P-1",
          initialKg: 100,
          pieces: 4,
          pricePerKg: 2,
          currency: "USD",
          entryDate: "2026-01-01",
        },
        ctx,
      ),
    );
    must(
      await t.phone.documents.createInvoice({
        type: "sale",
        date: "2026-02-10",
        partyId: customer,
        partyType: "customer",
        currency: "USD",
        exchangeRate: 1,
        lines: [
          {
            fabricId: fabric.id,
            colorId,
            rollId: roll.id,
            quantityKg: 10,
            pieces: 1,
            pricePerKg: 5,
          },
        ],
        paid: 0,
        preAllocatedNumber: t.nextNumber("INV"),
      } as never),
    );
    must(
      await t.phone.documents.createVoucher("receipt", {
        date: "2026-03-05",
        partyId: customer,
        partyKind: "customer",
        amount: 20,
        currency: "USD",
        exchangeRate: 1,
        method: "cash",
        preAllocatedNumber: t.nextNumber("VOC"),
      }),
    );
    must(
      await t.phone.documents.createVoucher("payment", {
        date: "2026-03-06",
        partyId: supplier,
        partyKind: "supplier",
        amount: 15,
        currency: "USD",
        exchangeRate: 1,
        method: "cash",
        preAllocatedNumber: t.nextNumber("VOC"),
      }),
    );
    const invoice = (await listSourceInvoices(t.phone, "sale", customer))[0]!;
    const lines = (await loadReturnableLines(t.phone, invoice.id))!;
    must(
      await t.phone.documents.createReturn(
        toReturnInput(
          {
            ...emptyReturnDraft("sale"),
            party: { id: customer, name: "محل النور" },
            invoice,
            currency: "USD",
            lines: lines.lines,
            qty: { [lines.lines[0]!.rollId]: { kg: 2, pieces: 0 } },
          },
          "2026-03-10",
        ),
      ),
    );
  });
  afterAll(() => t?.close());

  it("search by name, code and phone digits", async () => {
    for (const q of ["النور", "C-9", "0933123"]) {
      expect(
        (await listParties(t.phone, { q, kind: "" })).map((p) => p.id),
        q,
      ).toEqual([customer]);
    }
    expect((await listParties(t.phone, { q: "", kind: "supplier" })).map((p) => p.id)).toEqual([
      supplier,
    ]);
  });

  it("customer balance: 50 sale − 20 receipt − 10 return = 20 owed to us; supplier paid in advance", async () => {
    const c = await partyBalances(t.phone, customer, "customer");
    expect(c).toEqual([expect.objectContaining({ currency: "USD", balance: 20, side: "debit" })]);
    expect(balanceSideLabel(c[0]!.side, "customer")).toBe("مدين (على العميل)");
    const s = await partyBalances(t.phone, supplier, "supplier");
    expect(s[0]).toMatchObject({ currency: "USD", balance: -15 });
    expect(balanceSideLabel(s[0]!.side, "supplier")).toBe("مدين (على المورد)");
  });

  it("profile and documents by kind", async () => {
    const p = await loadPartyProfile(t.phone, customer);
    expect(p).toMatchObject({ name: "محل النور", code: "C-9", phones: ["0933 123 456"] });
    const inv = await partyDocuments(t.phone, customer, "invoices");
    expect(inv).toEqual([
      expect.objectContaining({ title: "فاتورة بيع", amount: 50, note: "متبقي 50.00" }),
    ]);
    const vouchers = await partyDocuments(t.phone, customer, "vouchers");
    expect(vouchers.map((v) => [v.title, v.amount])).toEqual([["سند قبض", 20]]);
    const returns = await partyDocuments(t.phone, customer, "returns");
    expect(returns.map((r) => r.title)).toEqual(["مرتجع بيع"]);
  });

  it("statement: all lines with the desktop's names, and a period starting from the previous balance", async () => {
    const all = await loadStatement(t.phone, {
      partyId: customer,
      kind: "customer",
      currency: "ALL",
      from: null,
      to: null,
    });
    expect(all.entries.map((e) => STATEMENT_TYPE_LABEL[e.type])).toEqual([
      "فاتورة بيع",
      "سند قبض",
      "مرتجع بيع",
    ]);
    expect(all.totals).toEqual([
      expect.objectContaining({ currency: "USD", previous: 0, debit: 50, credit: 30, closing: 20 }),
    ]);
    const march = await loadStatement(t.phone, {
      partyId: customer,
      kind: "customer",
      currency: "USD",
      from: "2026-03-01",
      to: "2026-03-31",
    });
    expect(march.entries).toHaveLength(2);
    expect(march.totals[0]).toMatchObject({ previous: 50, debit: 0, credit: 30, closing: 20 });
  });
});
