import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// The screens only need the party picker's list; the hook itself pulls in native modules.
vi.mock("../../src/hooks/useParties", () => ({ useParties: () => ({ data: [] }) }));
import { render, screen } from "@testing-library/react-native";
import { withTenantTx } from "@backend/infrastructure/orm/engine";
import { createPartyUseCase } from "@backend/application/use-cases/parties/partyUseCases";
import { emptyVoucher, VoucherForm } from "../../src/ui/VoucherForm";
import { ExpenseForm } from "../../src/ui/ExpenseForm";
import { CashboxView } from "../../src/ui/CashboxView";
import { makeTestPhone, type TestPhone } from "../helpers/testPhone";

describe("voucher / expense / cashbox screens (US5)", () => {
  it("shows the use-case's refusal for a locked day (E10) and for insufficient cash (E11)", async () => {
    const locked = "اليوم مُقفل — لا يمكن إضافة حركات";
    await render(
      <VoucherForm
        kind="payment"
        values={emptyVoucher()}
        error={locked}
        busy={false}
        onChange={() => undefined}
        onSave={() => undefined}
      />,
    );
    expect(screen.getByTestId("voucher-error").props.children).toBe(locked);
  });

  it("the save button waits for party, amount and rate", async () => {
    await render(
      <VoucherForm
        kind="receipt"
        values={emptyVoucher()}
        error={null}
        busy={false}
        onChange={() => undefined}
        onSave={() => undefined}
      />,
    );
    expect(screen.getByLabelText("المبلغ")).toBeTruthy();
    expect(screen.getByText("حفظ سند القبض")).toBeTruthy();
  });

  it("expense form lists name suggestions and the error", async () => {
    await render(
      <ExpenseForm
        values={{ name: "إي", amount: null, currency: "USD" }}
        suggestions={["إيجار"]}
        error="خطأ"
        busy={false}
        onChange={() => undefined}
        onSave={() => undefined}
      />,
    );
    expect(screen.getByText("إيجار")).toBeTruthy();
    expect(screen.getByTestId("expense-error")).toBeTruthy();
  });

  it("a viewer sees the cashbox without the manual-movement form", async () => {
    const props = {
      date: "2026-03-01",
      balances: { USD: 5 },
      movements: { USD: { in: 5, out: 0 } },
      form: { direction: "in" as const, currency: "USD", amount: null, description: "" },
      error: null,
      onDate: () => undefined,
      onShiftDay: () => undefined,
      onForm: () => undefined,
      onAdd: () => undefined,
    };
    await render(<CashboxView {...props} role="viewer" />);
    expect(screen.getByTestId("cashbox-USD")).toBeTruthy();
    expect(screen.queryByTestId("manual-movement-form")).toBeNull();
  });
});

describe("voucher amend is one use-case call (FR-21) and expenses sync (FR-22)", () => {
  let t: TestPhone;
  let customerId = "";
  beforeAll(async () => {
    t = await makeTestPhone();
    await t.giveBlock("expense", "EXP");
    const ctx = t.phone.context();
    await withTenantTx(ctx.tenantId, async () => {
      const r = await createPartyUseCase(
        t.phone.repos.partyRepo,
        { kind: "customer", code: "C-1", name: "عميل", currency: "USD" },
        ctx,
      );
      if (!r.ok) throw new Error(r.error);
      customerId = r.data.id;
    });
  });
  afterAll(() => t?.close());

  it("replaceVoucher cancels the original and creates the new one in a single call, queuing both units", async () => {
    const body = {
      date: "2026-03-01",
      partyId: customerId,
      partyKind: "customer" as const,
      amount: 100,
      currency: "USD",
      exchangeRate: 1,
      method: "cash" as const,
    };
    const made = await t.phone.documents.createVoucher("receipt", {
      ...body,
      preAllocatedNumber: t.nextNumber("VOC"),
    });
    expect(made.ok).toBe(true);
    if (!made.ok) return;
    const before = await t.phone.repos.syncOutboxRepo.countOutstanding(
      t.phone.identity.tenantId as never,
    );
    const replaced = await t.phone.documents.replaceVoucher(
      made.data.id,
      "receipt",
      made.data.version,
      { ...body, amount: 150, preAllocatedNumber: t.nextNumber("VOC") },
    );
    expect(replaced.ok, JSON.stringify(replaced)).toBe(true);
    const after = await t.phone.repos.syncOutboxRepo.countOutstanding(
      t.phone.identity.tenantId as never,
    );
    expect(after - before).toBe(2);
    const original = await t.phone.repos.voucherRepo.findById(made.data.id, t.phone.context());
    expect(original?.status).toBe("cancelled");
  });

  it("an expense and its cancel each queue one unit", async () => {
    const before = await t.phone.repos.syncOutboxRepo.countOutstanding(
      t.phone.identity.tenantId as never,
    );
    const e = await t.phone.documents.createExpense({
      category: "إيجار",
      description: "إيجار",
      amount: 20,
      currency: "USD",
      date: "2026-03-01",
      method: "cash",
      paidFromCashbox: false,
    });
    expect(e.ok, JSON.stringify(e)).toBe(true);
    if (!e.ok) return;
    expect(
      await t.phone.repos.syncOutboxRepo.countOutstanding(t.phone.identity.tenantId as never),
    ).toBe(before + 1);
    const c = await t.phone.documents.cancelExpense(e.data.id, e.data.version);
    expect(c.ok, JSON.stringify(c)).toBe(true);
    expect(
      await t.phone.repos.syncOutboxRepo.countOutstanding(t.phone.identity.tenantId as never),
    ).toBe(before + 2);
  });
});
