import { describe, expect, it, vi } from "vitest";
import { ScrollView } from "react-native";
import { fireEvent, render, screen } from "@testing-library/react-native";

vi.mock("../../src/hooks/useParties", () => ({ usePartyList: () => ({ data: [] }) }));

import {
  DocumentDoneView,
  LineEditorSheet,
  lineFromLot,
  SaleFormView,
} from "../../src/ui/SaleViews";
import { LotPickerView } from "../../src/ui/LotPicker";
import { InvoiceDetailView } from "../../src/ui/InvoiceDetailView";
import {
  draftProblems,
  emptyDraft,
  saleSettlement,
  toCreateInput,
  type SaleDraft,
} from "../../src/core/saleDraft";
import { withQuery } from "../helpers/withQuery";

const lot = {
  id: "r1",
  rollNo: "DL-1",
  fabricId: "f1",
  fabricName: "قطن",
  colorId: "c1",
  colorName: "أبيض",
  colorCode: null,
  remainingKg: 120.5,
  remainingPieces: 3,
  defaultPricePerKg: 4.5,
  currency: "USD",
  dyeBatch: "D-12",
  widthCm: 180,
  weightGsm: 210,
  costPerKg: 3.1,
};

const noop = () => undefined;
const formProps = (draft: SaleDraft) => ({
  draft,
  error: null,
  today: "2026-03-01",
  availableCredit: null as number | null,
  showCost: false,
  onParty: noop,
  onCurrency: noop,
  onRate: noop,
  onAddLot: noop,
  onEditLine: noop,
  onRemoveLine: noop,
  onPatch: noop,
  onDiscard: noop,
  onSave: vi.fn(async () => undefined),
});

describe("lot picker", () => {
  it("lists available lots with fabric, colour, kg and the sale price, and picks one", async () => {
    const onPick = vi.fn();
    await render(<LotPickerView q="" onQuery={noop} lots={[lot]} onPick={onPick} />);
    expect(screen.getByText("قطن · أبيض")).toBeTruthy();
    expect(screen.getByText("120.50 كغ")).toBeTruthy();
    expect(
      screen.getByText("رقم الصبغة D-12 · كراماج 210 · عرض 180 سم · سعر البيع 4.50 USD"),
    ).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("صبغة DL-1"));
    expect(onPick).toHaveBeenCalledWith(lot);
  });

  it("a picked lot starts at 1 kg at its sale price", () => {
    expect(lineFromLot(lot, "k")).toMatchObject({
      quantityKg: 1,
      pricePerKg: 4.5,
      rollCurrency: "USD",
    });
    expect(lineFromLot({ ...lot, remainingKg: 0.4 }, "k").quantityKg).toBe(0.4);
  });
});

describe("sale form", () => {
  it("says what is missing only after a save attempt, and does not save", async () => {
    const props = formProps(emptyDraft());
    await render(withQuery(<SaleFormView {...props} />));
    expect(screen.queryByTestId("sale-problems")).toBeNull();
    await fireEvent.press(screen.getByLabelText("حفظ الفاتورة"));
    expect(screen.getByTestId("sale-problems")).toBeTruthy();
    expect(props.onSave).not.toHaveBeenCalled();
  });

  it("a USD sale of USD lots needs no rate; lines show kg × price and the total", async () => {
    const draft: SaleDraft = {
      ...emptyDraft(),
      party: { id: "p", name: "محل النور" },
      lines: [{ ...lineFromLot(lot, "k1"), quantityKg: 10 }],
      paid: 20,
    };
    const props = formProps(draft);
    await render(withQuery(<SaleFormView {...props} />));
    expect(screen.queryByLabelText("سعر الصرف (ليرة لكل 1 دولار)")).toBeNull();
    expect(screen.getByText("صبغة DL-1 · 10.00 كغ × 4.50 USD")).toBeTruthy();
    expect(screen.getAllByText("45.00 USD").length).toBeGreaterThan(0);
    expect(screen.getByText("25.00 USD")).toBeTruthy(); // due
    await fireEvent.press(screen.getByLabelText("حفظ الفاتورة"));
    expect(props.onSave).toHaveBeenCalledOnce();
  });

  it("an SYP sale asks for the rate", async () => {
    await render(withQuery(<SaleFormView {...formProps({ ...emptyDraft(), currency: "SYP" })} />));
    expect(screen.getByLabelText("سعر الصرف (ليرة لكل 1 دولار)")).toBeTruthy();
  });

  it("the line editor refuses more kg than the lot holds", async () => {
    await render(
      <LineEditorSheet
        line={{ ...lineFromLot(lot, "k1"), quantityKg: 200 }}
        currency="USD"
        onChange={noop}
        onRemove={noop}
        onClose={noop}
      />,
    );
    expect(screen.getByText("أكبر من المتوفر في الصبغة")).toBeTruthy();
    expect(screen.getByLabelText("تم").props.accessibilityState.disabled).toBe(true);
  });

  it("done screen: number, share slot and a new invoice", async () => {
    const onNew = vi.fn();
    await render(
      <DocumentDoneView
        title="فاتورة البيع"
        number="INV-7"
        onNew={onNew}
        newLabel="فاتورة بيع جديدة"
      />,
    );
    expect(screen.getByTestId("sale-done-number").props.children).toBe("INV-7");
    await fireEvent.press(screen.getByLabelText("فاتورة بيع جديدة"));
    expect(onNew).toHaveBeenCalled();
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
      type: "entry",
      reference: "F-501",
      subtotal: 50,
      discount: 0,
      tax: 0,
      shipping: 0,
      paymentMethod: "transfer",
      notes: "المرجع: F-501 • طريقة الدفع: تحويل بنكي • تسليم المستودع الثاني",
    },
    partyName: "عميل",
    party: { name: "عميل", phone: "0933", address: null, city: null, code: null },
    vouchers: [
      {
        id: "v1",
        kind: "payment",
        number: "PAY-3",
        date: "2026-03-02",
        amount: 20,
        currency: "USD",
        method: "cash",
      },
    ],
    lines: [
      {
        id: "l1",
        fabric: "قطن",
        color: "أبيض",
        colorCode: "W-1",
        rollNo: "R-1",
        dyeBatch: "D-4",
        quantityKg: 10,
        pieces: 0,
        pricePerKg: 5,
        discountAmount: 0,
        lineTotal: 50,
        widthCm: 180,
        weightGsm: null,
        note: "رقم الماكينة: 12 • كراماج: 180 • السحب: 3 • وزن قائم: 10.6",
      },
    ],
  } as never;

  it("shows what the desktop invoice page shows: reference, pieces, line details, linked vouchers, notes", async () => {
    const onNewVoucher = vi.fn();
    await render(
      <InvoiceDetailView
        view={view}
        role="accountant"
        error={null}
        onCancel={vi.fn()}
        onNewVoucher={onNewVoucher}
      />,
    );
    expect(screen.getByTestId("invoice-reference")).toBeTruthy();
    expect(screen.getByText("قطن · أبيض (W-1)")).toBeTruthy();
    expect(screen.getByText(/رقم الصبغة D-4/)).toBeTruthy();
    expect(
      screen.getByText("ماكينة 12 · كراماج 180 · سحب 3 · قائم 10.60 كغ · عرض 180 سم"),
    ).toBeTruthy();
    expect(screen.getByText(/سند صرف PAY-3/)).toBeTruthy();
    expect(screen.getByText("تحويل بنكي")).toBeTruthy();
    // The notes card shows only the free text (number and method are already above).
    expect(screen.getByText("تسليم المستودع الثاني")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("invoice-new-voucher"));
    expect(onNewVoucher).toHaveBeenCalled();
  });

  it("admin and accountant can cancel, warehouse and viewer cannot", async () => {
    const onCancel = vi.fn();
    await render(
      <InvoiceDetailView view={view} role="accountant" error={null} onCancel={onCancel} />,
    );
    await fireEvent.press(screen.getByLabelText("إلغاء الفاتورة"));
    await fireEvent.press(screen.getByTestId("confirm-yes"));
    expect(onCancel).toHaveBeenCalled();
    await render(<InvoiceDetailView view={view} role="viewer" error={null} onCancel={onCancel} />);
    expect(screen.queryAllByLabelText("إلغاء الفاتورة")).toHaveLength(0);
  });

  it("after a cancel the page scrolls back to the top, where it now says the invoice is cancelled", async () => {
    const calls = (ScrollView as unknown as { scrollCalls: Array<{ y: number }> }).scrollCalls;
    const before = calls.length;
    const v = view as { invoice: Record<string, unknown> };
    const { rerender } = await render(
      <InvoiceDetailView view={view} role="admin" error={null} onCancel={vi.fn()} />,
    );
    expect(calls.length).toBe(before); // not on first render
    const cancelled = { ...v, invoice: { ...v.invoice, status: "cancelled" } } as never;
    await rerender(
      <InvoiceDetailView view={cancelled} role="admin" error={null} onCancel={vi.fn()} />,
    );
    expect(calls.slice(before)).toEqual([{ y: 0, animated: true }]);
    expect(screen.getByTestId("invoice-cancelled")).toBeTruthy();
  });
});

describe("sale like the desktop's form", () => {
  it("settlement: the desktop's planSaleSettlement cases (src/presentation/hooks/useCustomerCredit.test.ts)", () => {
    expect(
      saleSettlement({ total: 10_000, cashPaid: 20_000, availableCredit: 0, useCredit: true }),
    ).toEqual({ cashApplied: 10_000, creditApplied: 0, excessCash: 10_000, debt: 0 });
    expect(
      saleSettlement({ total: 12_000, cashPaid: 0, availableCredit: 15_000, useCredit: true }),
    ).toEqual({ cashApplied: 0, creditApplied: 12_000, excessCash: 0, debt: 0 });
    expect(
      saleSettlement({ total: 8_000, cashPaid: 1_000, availableCredit: 3_000, useCredit: true }),
    ).toEqual({ cashApplied: 1_000, creditApplied: 3_000, excessCash: 0, debt: 4_000 });
    expect(
      saleSettlement({ total: 8_000, cashPaid: 0, availableCredit: 3_000, useCredit: false }),
    ).toEqual({ cashApplied: 0, creditApplied: 0, excessCash: 0, debt: 8_000 });
  });

  const withLine = (patch: Partial<SaleDraft> = {}): SaleDraft => ({
    ...emptyDraft(),
    party: { id: "p1", name: "عميل" },
    lines: [{ ...lineFromLot(lot, "k1"), quantityKg: 10, pieces: 2, note: " طي خاص " }],
    ...patch,
  });

  it("refuses more pieces than the lot has and a discount above the line, like the desktop", () => {
    expect(draftProblems(withLine())).toEqual([]);
    expect(
      draftProblems(withLine({ lines: [{ ...lineFromLot(lot, "k"), quantityKg: 1, pieces: 4 }] })),
    ).toEqual(["over-pieces"]);
    expect(
      draftProblems(
        withLine({ lines: [{ ...lineFromLot(lot, "k"), quantityKg: 1, discountAmount: 5 }] }),
      ),
    ).toEqual(["discount-over"]);
  });

  it("sends reference, date, payment method, notes, line note and the credit used", () => {
    const input = toCreateInput(
      withLine({
        reference: "PO-3",
        date: "2026-02-27",
        paymentMethod: "check",
        notes: "تسليم غداً",
        useCredit: true,
      }),
      "2026-03-01",
      20,
    );
    expect(input).toMatchObject({
      date: "2026-02-27",
      reference: "PO-3",
      paymentMethod: "check",
      creditApplied: 20,
      notes: "المرجع: PO-3 • طريقة الدفع: شيك • تسليم غداً",
    });
    expect(input.lines[0]).toMatchObject({ note: "طي خاص", pieces: 2 });
    expect(toCreateInput(withLine(), "2026-03-01", 20)).not.toHaveProperty("creditApplied");
  });

  it("offers the customer's credit, shows what it covers, kg and pieces in the footer", async () => {
    const props = { ...formProps(withLine({ useCredit: true })), availableCredit: 30 };
    await render(withQuery(<SaleFormView {...props} />));
    expect(screen.getByTestId("sale-credit-yes")).toBeTruthy();
    expect(screen.getByTestId("sale-credit-applied")).toBeTruthy();
    expect(screen.getByText("30.00 USD")).toBeTruthy();
    expect(screen.getByTestId("sale-footer-qty").props.children).toBe("10.00 كغ · 2 ثوب");
    expect(screen.getByLabelText("رقم المرجعية")).toBeTruthy();
    expect(screen.getByLabelText("التاريخ").props.placeholder).toBe("2026-03-01");
  });

  it("the line sheet warns below the lot's cost and has a note", async () => {
    await render(
      <LineEditorSheet
        line={{ ...lineFromLot(lot, "k"), pricePerKg: 3 }}
        currency="USD"
        onChange={noop}
        onRemove={noop}
        onClose={noop}
      />,
    );
    expect(screen.getByTestId("line-below-cost")).toBeTruthy();
    expect(screen.getByLabelText("ملاحظة (اختياري)")).toBeTruthy();
  });
});
