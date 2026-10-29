import { describe, expect, it, vi } from "vitest";
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
import { emptyDraft, type SaleDraft } from "../../src/core/saleDraft";
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
};

const noop = () => undefined;
const formProps = (draft: SaleDraft) => ({
  draft,
  error: null,
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
    expect(screen.getByText("سعر البيع 4.50 USD")).toBeTruthy();
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
