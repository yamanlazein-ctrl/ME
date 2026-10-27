import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenantTx } from "@backend/infrastructure/orm/engine";
import { createPartyUseCase } from "@backend/application/use-cases/parties/partyUseCases";
import { createFabricUseCase } from "@backend/application/use-cases/inventory/fabricUseCases";
import { createColorUseCase } from "@backend/application/use-cases/inventory/colorUseCases";
import { createRollUseCase } from "@backend/application/use-cases/inventory/rollUseCases";
import * as profitUc from "@backend/application/use-cases/profit/profitUseCases";
import {
  loadDetail,
  loadPartyBalances,
  loadProfit,
  loadSummary,
  periodFrom,
  REPORT_LIST,
} from "../../src/core/reports";
import { makeTestPhone, type TestPhone } from "../helpers/testPhone";

const must = <T>(r: { ok: true; data: T } | { ok: false; error: string }) => {
  if (!r.ok) throw new Error(r.error);
  return r.data;
};

describe("reports", () => {
  let t: TestPhone;
  const today = new Date().toISOString().slice(0, 10);

  beforeAll(async () => {
    t = await makeTestPhone();
    await t.giveBlock("expense", "EXP");
    const ctx = t.phone.context();
    const party = await withTenantTx(ctx.tenantId, async () =>
      must(
        await createPartyUseCase(
          t.phone.repos.partyRepo,
          { kind: "customer", code: "C-REP", name: "عميل التقارير", currency: "USD" },
          ctx,
        ),
      ),
    );
    const fabric = must(
      await createFabricUseCase(
        t.phone.repos.fabricRepo,
        { name: "قطن تقارير", minStockKg: 0 },
        ctx,
      ),
    );
    const color = must(
      await createColorUseCase(t.phone.repos.colorRepo, { fabricId: fabric.id, name: "أحمر" }, ctx),
    );
    const roll = must(
      await createRollUseCase(
        t.phone.repos.rollRepo,
        {
          colorId: color.id,
          rollNo: "REP-1",
          initialKg: 100,
          pieces: 4,
          pricePerKg: 3,
          currency: "USD",
          entryDate: today,
        },
        ctx,
      ),
    );
    const sale = await t.phone.documents.createInvoice({
      type: "sale",
      date: today,
      partyId: party.id,
      partyType: "customer",
      currency: "USD",
      exchangeRate: 1,
      discount: 4,
      lines: [
        {
          fabricId: fabric.id,
          colorId: color.id,
          rollId: roll.id,
          quantityKg: 10,
          pieces: 0,
          pricePerKg: 5,
        },
      ],
      paid: 20,
      preAllocatedNumber: t.nextNumber("INV"),
    } as never);
    if (!sale.ok) throw new Error(sale.error);
    const exp = await t.phone.documents.createExpense({
      category: "أخرى",
      description: "اختبار",
      amount: 6,
      currency: "USD",
      date: today,
      method: "cash",
      paidFromCashbox: false,
    });
    if (!exp.ok) throw new Error(exp.error);
  });
  afterAll(() => t?.close());

  it("periods start where the desktop's do", () => {
    const d = new Date(2026, 4, 17);
    expect(periodFrom("all", d)).toBeNull();
    expect(periodFrom("month", d)).toBe("2026-05-01");
    expect(periodFrom("year", d)).toBe("2026-01-01");
    expect(periodFrom("last30", d)).toBe("2026-04-17");
  });

  it("the overview, every detail report and party balances load, per currency", async () => {
    const s = await loadSummary(t.phone, null);
    const sales = s.figures.find((f) => f.label === "المبيعات");
    expect(sales?.amounts).toEqual([{ currency: "USD", amount: 46 }]);
    expect(s.figures.find((f) => f.label === "المصروفات")?.amounts).toEqual([
      { currency: "USD", amount: 6 },
    ]);
    for (const { slug } of REPORT_LIST) {
      const page = await loadDetail(t.phone, slug, null);
      expect(page, slug).not.toBeNull();
    }
    expect((await loadDetail(t.phone, "net-sales", null))?.lines).toHaveLength(1);
    expect(await loadDetail(t.phone, "nope", null)).toBeNull();
    const balances = await loadPartyBalances(t.phone, "customer");
    expect(balances).toEqual([
      expect.objectContaining({ name: "عميل التقارير", currency: "USD", remaining: 26 }),
    ]);
  });

  it("profit: revenue = subtotal - discount, cost from the line snapshot, equal to the use-case output", async () => {
    const report = await loadProfit(t.phone, "all");
    const usd = report.byCurrency.find((c) => c.currency === "USD");
    expect(usd).toMatchObject({ salesRevenue: 46, cogs: 30, expenses: 6, netProfit: 10 });
    const direct = must(
      await profitUc.getProfitSummaryUseCase(t.phone.repos.profitRepo, {}, t.phone.context()),
    );
    expect(report.byCurrency).toEqual(direct.byCurrency);
    expect(report.lines[0]?.amounts).toEqual([{ currency: "USD", amount: 16 }]);
  });
});
