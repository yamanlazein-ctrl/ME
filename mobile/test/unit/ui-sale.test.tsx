import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react-native";

vi.mock("../../src/hooks/useParties", () => ({ useParties: () => ({ data: [] }) }));

import { RollPicker } from "../../src/ui/RollPicker";
import { SaleDoneView, SaleReviewView } from "../../src/ui/SaleViews";
import { InvoiceDetailView } from "../../src/ui/InvoiceDetailView";
import { emptyDraft } from "../../src/core/saleDraft";

const rolls = [
  {
    id: "r1",
    rollNo: "R-1",
    remainingKg: 120.5,
    remainingPieces: 3,
    pricePerKg: 4,
    currency: "USD",
  },
  { id: "r2", rollNo: "R-0", remainingKg: 0, remainingPieces: 0, pricePerKg: 4, currency: "USD" },
];

describe("roll picker (T099)", () => {
  it("walks fabric → colour → roll, shows the remaining kg and blocks a 0 kg roll", async () => {
    const onPick = vi.fn();
    await render(
      <RollPicker
        fabrics={[{ id: "f1", name: "قطن" }]}
        loadColors={async () => [{ id: "c1", name: "أبيض" }]}
        loadRolls={async () => rolls}
        onPick={onPick}
        onClose={() => undefined}
      />,
    );
    await fireEvent.press(screen.getByText("قطن"));
    await fireEvent.press(await screen.findByText("أبيض"));
    expect(await screen.findByText("المتبقي: 120.5 كغ")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("roll-R-0"));
    expect(onPick).not.toHaveBeenCalled();
    await fireEvent.press(screen.getByTestId("roll-R-1"));
    expect(onPick).toHaveBeenCalledOnce();
  });
});

describe("sale review and done screens (T100, T101)", () => {
  it("review blocks saving until the draft is complete and shows what is missing", async () => {
    await render(
      <SaleReviewView
        draft={emptyDraft()}
        busy={false}
        error={null}
        onPatch={() => undefined}
        onSave={() => undefined}
      />,
    );
    expect(screen.getByText("اختر العميل")).toBeTruthy();
    expect(screen.getByText("أضف بنداً واحداً على الأقل")).toBeTruthy();
  });

  it("done screen offers share PDF, a placeholder for send-to-customer, and a new invoice", async () => {
    const onSharePdf = vi.fn();
    const onNew = vi.fn();
    await render(
      <SaleDoneView
        number="INV-2026-0007"
        onSharePdf={onSharePdf}
        onNew={onNew}
        onOpen={() => undefined}
      />,
    );
    expect(screen.getByTestId("sale-done-number").props.children).toBe(
      "تم حفظ الفاتورة INV-2026-0007",
    );
    await fireEvent.press(screen.getByLabelText("مشاركة PDF"));
    await fireEvent.press(screen.getByLabelText("فاتورة جديدة"));
    expect(onSharePdf).toHaveBeenCalled();
    expect(onNew).toHaveBeenCalled();
    expect(screen.getByLabelText("إرسال للعميل (قريباً)").props.accessibilityState.disabled).toBe(
      true,
    );
  });
});

describe("invoice detail (T102)", () => {
  const view = {
    invoice: {
      id: "i",
      number: "INV-1",
      date: "2026-03-01",
      currency: "USD",
      total: 50,
      paid: 20,
      amountDue: 30,
      status: "active",
      version: 1,
    },
    partyName: "عميل",
    lines: [
      {
        id: "l1",
        fabric: "قطن",
        color: "أبيض",
        rollNo: "R-1",
        quantityKg: 10,
        pieces: 0,
        pricePerKg: 5,
        discountAmount: 0,
        lineTotal: 50,
      },
    ],
  } as never;

  it("admin and accountant can cancel, warehouse and viewer cannot", async () => {
    const onCancel = vi.fn();
    await render(
      <InvoiceDetailView
        view={view}
        role="accountant"
        error={null}
        onCancel={onCancel}
        onShare={() => undefined}
      />,
    );
    await fireEvent.press(screen.getByLabelText("إلغاء الفاتورة"));
    expect(onCancel).toHaveBeenCalled();
    await render(
      <InvoiceDetailView
        view={view}
        role="viewer"
        error={null}
        onCancel={onCancel}
        onShare={() => undefined}
      />,
    );
    expect(screen.queryAllByLabelText("إلغاء الفاتورة")).toHaveLength(0);
  });
});
