// Every write shows in every related phone screen, read through the same functions those screens use (stock, party
// page, statement, home, cashbox). Expected figures are computed here from the inputs, never from the code under test.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react-native";

vi.mock("../../src/hooks/useParties", () => ({ usePartyList: () => ({ data: [] }) }));

import { withTenantTx } from "@backend/infrastructure/orm/engine";
import { createPartyUseCase } from "@backend/application/use-cases/parties/partyUseCases";
import { localDateISO } from "@backend/infrastructure/utils/localDate";
import { cashboxBalances } from "../../src/core/cashbox";
import { loadDashboard } from "../../src/core/dashboard";
import {
  balanceSideLabel,
  loadStatement,
  partyBalances,
  partyDocuments,
} from "../../src/core/parties";
import {
  emptyReturnDraft,
  listSourceInvoices,
  loadReturnableLines,
  toReturnInput,
} from "../../src/core/returns";
import { emptyDraft, toCreateInput } from "../../src/core/saleDraft";
import { listFabrics, loadColorLots, loadFabric, loadLot, pickLots } from "../../src/core/stock";
import { lineFromLot, SaleFormView } from "../../src/ui/SaleViews";
import { makeTestPhone, type TestPhone } from "../helpers/testPhone";
import { withQuery } from "../helpers/withQuery";

const must = <T,>(r: { ok: true; data: T } | { ok: false; error: string }) => {
  if (!r.ok) throw new Error(r.error);
  return r.data;
};

describe("a write is reflected in every related screen", () => {
  let t: TestPhone;
  let supplier = "";
  let customer = "";
  let lotId = "";
  let saleId = "";
  const today = localDateISO(new Date());
  const usd = async (partyId: string, kind: "customer" | "supplier") =>
    (await partyBalances(t.phone, partyId, kind)).find((b) => b.currency === "USD");
  const cash = async () => (await cashboxBalances(t.phone, today)).USD ?? 0;
  const statement = (partyId: string, kind: "customer" | "supplier") =>
    loadStatement(t.phone, { partyId, kind, currency: "USD", from: null, to: null });

  beforeAll(async () => {
    t = await makeTestPhone();
    await t.giveBlock("invoice_entry", "ENT");
    await t.giveBlock("return", "RET");
    const ctx = t.phone.context();
    const party = (kind: "customer" | "supplier", code: string, name: string) =>
      withTenantTx(
        ctx.tenantId,
        async () =>
          must(
            await createPartyUseCase(
              t.phone.repos.partyRepo,
              { kind, code, name, currency: "USD" },
              ctx,
            ),
          ).id,
      );
    supplier = await party("supplier", "S-X", "مورد المتابعة");
    customer = await party("customer", "C-X", "عميل المتابعة");
    // Cash in the drawer so payments are not refused for insufficient cash.
    must(
      await t.phone.documents.addCashboxMovement({
        date: today,
        type: "capital",
        direction: "in",
        amount: 1000,
        currency: "USD",
      }),
    );
  });
  afterAll(() => t?.close());

  it("purchase invoice (120, paid 20): document, new lot, supplier balance and statement, payables, cash", async () => {
    const entry = must(
      await t.phone.documents.createEntryInvoice({
        date: today,
        supplierId: supplier,
        currency: "USD",
        exchangeRate: 1,
        paid: 20,
        lines: [
          { fabricName: "قطن متابعة", colorName: "أبيض", quantityKg: 40, pieces: 2, pricePerKg: 3 },
        ],
      }),
    );
    const docs = await partyDocuments(t.phone, supplier, "invoices");
    expect(docs).toEqual([
      expect.objectContaining({
        id: entry.id,
        title: "فاتورة دخول",
        amount: 120,
        note: "متبقي 100.00",
      }),
    ]);
    const fabric = (await listFabrics(t.phone, "قطن متابعة"))[0]!;
    expect(fabric).toMatchObject({ remainingKg: 40, pieces: 2, activeLots: 1 });
    const colorId = (await loadFabric(t.phone, fabric.id))!.colors[0]!.id;
    lotId = (await loadColorLots(t.phone, colorId))!.lots[0]!.id;
    const lot = (await loadLot(t.phone, lotId))!;
    expect(
      lot.movements.map((m) => [m.label, m.direction, m.quantityKg, m.balanceAfterKg]),
    ).toContainEqual(["فاتورة دخول", "in", 40, 40]);
    expect(lot.supplierName).toBe("مورد المتابعة");
    const bal = (await usd(supplier, "supplier"))!;
    expect([bal.balance, balanceSideLabel(bal.side, "supplier")]).toEqual([100, "دائن (للمورد)"]);
    const st = await statement(supplier, "supplier");
    expect(st.totals[0]).toMatchObject({ credit: 120, debit: 20, closing: 100 });
    expect((await loadDashboard(t.phone)).payables.USD).toBe(100);
    expect(await cash()).toBe(980);
  });

  it("sale (10 kg × 5, paid 15): lot down with its movement, customer balance and statement, today's sales, receivables, cash", async () => {
    const lot = (await pickLots(t.phone, "قطن متابعة"))[0]!;
    const draft = {
      ...emptyDraft(),
      party: { id: customer, name: "عميل المتابعة" },
      lines: [{ ...lineFromLot(lot, "k"), quantityKg: 10, pricePerKg: 5 }],
      paid: 15,
    };
    saleId = must(
      await t.phone.documents.createInvoice({
        ...toCreateInput(draft, today),
        preAllocatedNumber: t.nextNumber("INV"),
      } as never),
    ).id;
    const after = (await loadLot(t.phone, lotId))!;
    expect(after.remainingKg).toBe(30);
    expect(
      after.movements.map((m) => [m.label, m.direction, m.quantityKg, m.balanceAfterKg]),
    ).toContainEqual(["فاتورة بيع", "out", 10, 30]);
    const bal = (await usd(customer, "customer"))!;
    expect([bal.balance, balanceSideLabel(bal.side, "customer")]).toEqual([
      35,
      "مدين (على العميل)",
    ]);
    const st = await statement(customer, "customer");
    expect(st.entries.map((e) => [e.type, Number(e.debit), Number(e.credit)])).toEqual([
      ["sales_invoice", 50, 0],
      ["receipt_in", 0, 15],
    ]);
    const home = await loadDashboard(t.phone);
    expect(home.dashboard.todaySales.byCurrency.USD).toMatchObject({ total: 50, count: 1 });
    expect(home.receivables.USD).toBe(35);
    expect(await cash()).toBe(995);
  });

  it("receipt (5) and payment (30): balances, statements, home, cash", async () => {
    const voucher = (kind: "receipt" | "payment", partyId: string, amount: number) =>
      t.phone.documents.createVoucher(kind, {
        date: today,
        partyId,
        partyKind: kind === "receipt" ? "customer" : "supplier",
        amount,
        currency: "USD",
        exchangeRate: 1,
        method: "cash",
        preAllocatedNumber: t.nextNumber("VOC"),
      });
    must(await voucher("receipt", customer, 5));
    must(await voucher("payment", supplier, 30));
    expect((await usd(customer, "customer"))!.balance).toBe(30);
    expect((await usd(supplier, "supplier"))!.balance).toBe(70);
    expect((await statement(customer, "customer")).totals[0]!.closing).toBe(30);
    expect((await statement(supplier, "supplier")).totals[0]!.closing).toBe(70);
    expect(
      (await partyDocuments(t.phone, customer, "vouchers")).map((v) => v.amount).sort(),
    ).toEqual([15, 5]);
    expect(await cash()).toBe(970);
  });

  it("sale return (2 kg): lot back up with its movement, customer balance down, statement line", async () => {
    const invoice = (await listSourceInvoices(t.phone, "sale", customer))[0]!;
    const lines = (await loadReturnableLines(t.phone, invoice.id))!;
    must(
      await t.phone.documents.createReturn(
        toReturnInput(
          {
            ...emptyReturnDraft("sale"),
            party: { id: customer, name: "عميل المتابعة" },
            invoice,
            currency: "USD",
            lines: lines.lines,
            qty: { [lotId]: { kg: 2, pieces: 0 } },
          },
          today,
        ),
      ),
    );
    const lot = (await loadLot(t.phone, lotId))!;
    expect(lot.remainingKg).toBe(32);
    expect(
      lot.movements.map((m) => [m.label, m.direction, m.quantityKg, m.balanceAfterKg]),
    ).toContainEqual(["مرتجع بيع", "in", 2, 32]);
    expect((await usd(customer, "customer"))!.balance).toBe(20);
    expect((await statement(customer, "customer")).entries.map((e) => e.type)).toContain(
      "sales_return",
    );
    expect((await partyDocuments(t.phone, customer, "returns")).map((r) => r.amount)).toEqual([10]);
  });

  it("a double tap on «حفظ الفاتورة» saves one invoice", async () => {
    const before = (await partyDocuments(t.phone, customer, "invoices")).length;
    const lot = (await pickLots(t.phone, "قطن متابعة"))[0]!;
    const draft = {
      ...emptyDraft(),
      party: { id: customer, name: "عميل المتابعة" },
      lines: [{ ...lineFromLot(lot, "k2"), quantityKg: 1, pricePerKg: 5 }],
    };
    const save = async () => {
      must(
        await t.phone.documents.createInvoice({
          ...toCreateInput(draft, today),
          preAllocatedNumber: t.nextNumber("INV"),
        } as never),
      );
    };
    const noop = () => undefined;
    await render(
      withQuery(
        <SaleFormView
          draft={draft}
          error={null}
          onParty={noop}
          onCurrency={noop}
          onRate={noop}
          onAddLot={noop}
          onEditLine={noop}
          onRemoveLine={noop}
          onPatch={noop}
          onDiscard={noop}
          onSave={save}
        />,
      ),
    );
    const button = screen.getByLabelText("حفظ الفاتورة");
    fireEvent.press(button);
    fireEvent.press(button);
    await vi.waitFor(async () =>
      expect((await partyDocuments(t.phone, customer, "invoices")).length).toBe(before + 1),
    );
    await new Promise((r) => setTimeout(r, 300));
    expect((await partyDocuments(t.phone, customer, "invoices")).length).toBe(before + 1);
    expect(saleId).not.toBe("");
  });
});
