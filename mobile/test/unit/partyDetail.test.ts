import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenantTx } from "@backend/infrastructure/orm/engine";
import { createPartyUseCase } from "@backend/application/use-cases/parties/partyUseCases";
import { balancesByCurrency, recentInvoices } from "../../src/core/partyQueries";
import { makeTestPhone, type TestPhone } from "../helpers/testPhone";

describe("party detail queries", () => {
  let t: TestPhone;
  let id = "";
  beforeAll(async () => {
    t = await makeTestPhone();
    const ctx = t.phone.context();
    id = await withTenantTx(ctx.tenantId, async () => {
      const r = await createPartyUseCase(
        t.phone.repos.partyRepo,
        { kind: "customer", code: "C-1", name: "عميل", currency: "USD" },
        ctx,
      );
      if (!r.ok) throw new Error(r.error);
      return r.data.id;
    });
    const v = await t.phone.documents.createVoucher("receipt", {
      date: "2026-03-01",
      partyId: id,
      partyKind: "customer",
      amount: 40,
      currency: "USD",
      exchangeRate: 1,
      method: "cash",
      preAllocatedNumber: t.nextNumber("VOC"),
    });
    if (!v.ok) throw new Error(v.error);
  });
  afterAll(() => t?.close());

  it("loads the balance per currency and the recent invoices without throwing", async () => {
    const balances = await balancesByCurrency(t.phone, id, "customer");
    expect(balances.USD).toBe(-40);
    expect(await recentInvoices(t.phone, id)).toEqual([]);
    const party = await t.phone.repos.partyRepo.findById(id, t.phone.context());
    expect(party?.name).toBe("عميل");
  });
});
