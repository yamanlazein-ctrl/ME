import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react-native";
import {
  NAME_HINT,
  PartyDetailView,
  emptyPartyForm,
  PartyFormView,
  PartyListView,
  StatementView,
  withNameHint,
} from "../../src/ui/PartyViews";

const rows = [
  { id: "p1", name: "زينب للأقمشة", kind: "customer", code: "CUS-1" },
  { id: "p2", name: "مورد الشام", kind: "supplier", code: "SUP-1" },
];

describe("party screens (US4)", () => {
  it("lists parties as cards and opens one", async () => {
    const onOpen = vi.fn();
    await render(
      <PartyListView
        rows={rows}
        q=""
        kind=""
        role="admin"
        onQuery={() => undefined}
        onKind={() => undefined}
        onOpen={onOpen}
        onNew={() => undefined}
      />,
    );
    await fireEvent.press(screen.getByText("زينب للأقمشة"));
    expect(onOpen).toHaveBeenCalledWith("p1");
    expect(screen.getByText("الكل")).toBeTruthy();
    expect(screen.getByText("العملاء")).toBeTruthy();
    expect(screen.getByText("الموردون")).toBeTruthy();
  });

  it("a viewer cannot create a party", async () => {
    await render(
      <PartyListView
        rows={rows}
        q=""
        kind=""
        role="viewer"
        onQuery={() => undefined}
        onKind={() => undefined}
        onOpen={() => undefined}
        onNew={() => undefined}
      />,
    );
    expect(screen.queryByText("طرف جديد")).toBeNull();
  });

  it("detail shows a balance per currency, the phone and the statement button", async () => {
    const onStatement = vi.fn();
    await render(
      <PartyDetailView
        party={{
          id: "p1",
          name: "زينب",
          kind: "customer",
          phone: "0999",
          balances: { USD: 120.5, SYP: -3_000_000 },
          invoices: [{ id: "i1", number: "INV-1", date: "2026-03-01", total: 80, currency: "USD" }],
        }}
        role="accountant"
        onStatement={onStatement}
        onEdit={() => undefined}
        onInvoice={() => undefined}
      />,
    );
    expect(screen.getByTestId("balance-USD")).toBeTruthy();
    expect(screen.getByTestId("balance-SYP")).toBeTruthy();
    expect(screen.getByTestId("party-phone")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("كشف الحساب"));
    expect(onStatement).toHaveBeenCalled();
  });

  it("the statement list renders its rows and the closing balance", async () => {
    const entries = Array.from({ length: 5 }, (_, i) => ({
      id: `e${i}`,
      seq: i,
      date: "2026-03-01",
      type: "receipt",
      status: "active",
      currency: "USD",
      referenceNumber: `VOC-${i}`,
      debit: 0,
      credit: 10,
      runningBalance: -10 * (i + 1),
    })) as never;
    await render(<StatementView entries={entries} closing={-50} />);
    expect(screen.getByTestId("statement-count")).toBeTruthy();
    expect(screen.getByText("الرصيد الختامي: -50")).toBeTruthy();
  });

  it("the duplicate-name error shows the desktop message plus the format hint (E12)", async () => {
    const message = "اسم العميل/المورد مستخدم مسبقاً — اختر اسماً مختلفاً أو افتح السجل الموجود.";
    await render(
      <PartyFormView
        values={{ ...emptyPartyForm(), name: "زينب" }}
        error={message}
        busy={false}
        onChange={() => undefined}
        onSave={() => undefined}
      />,
    );
    const shown = screen.getByTestId("party-form-error");
    expect(JSON.stringify(shown.props.children)).toContain(NAME_HINT);
    expect(withNameHint("خطأ آخر")).toBe("خطأ آخر");
  });
});
