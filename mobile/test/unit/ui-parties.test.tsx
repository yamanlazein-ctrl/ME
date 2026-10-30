import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { View } from "react-native";
import { fireEvent, render, screen, within } from "@testing-library/react-native";
import {
  STATEMENT_TYPE_LABEL,
  type PartyProfile,
  type StatementResult,
} from "../../src/core/parties";
import {
  emptyPartyForm,
  NAME_HINT,
  PartyDetailView,
  PartyFormView,
  PartyListView,
  periodRange,
  StatementView,
  withNameHint,
} from "../../src/ui/PartyViews";

const noop = () => undefined;

const listProps = {
  balances: {},
  q: "",
  kind: "" as const,
  role: "admin" as const,
  loading: false,
  error: null,
  refreshing: false,
  onQuery: noop,
  onKind: noop,
  onOpen: noop,
  onNew: noop,
  onRefresh: noop,
  onRetry: noop,
};

describe("party list", () => {
  it("shows kind, code, phone and each currency balance with the desktop's side words", async () => {
    await render(
      <PartyListView
        {...listProps}
        rows={[
          {
            id: "c",
            name: "محل النور",
            kind: "customer",
            code: "C-9",
            phone: "0933",
            city: "حلب",
            currency: "USD",
          },
        ]}
        balances={{
          c: [
            { currency: "USD", balance: 20, side: "debit", totalDebit: 50, totalCredit: 30 },
            { currency: "SYP", balance: -1000, side: "credit", totalDebit: 0, totalCredit: 1000 },
          ],
        }}
      />,
    );
    expect(screen.getByText("عميل · C-9 · حلب")).toBeTruthy();
    expect(screen.getByText("0933")).toBeTruthy();
    expect(screen.getByText("20.00 USD")).toBeTruthy();
    expect(screen.getByText("مدين (على العميل)")).toBeTruthy();
    expect(screen.getByText("1,000.00 SYP")).toBeTruthy();
    expect(screen.getByText("دائن (للعميل)")).toBeTruthy();
  });

  it("viewers cannot add; empty search says so", async () => {
    await render(<PartyListView {...listProps} role="viewer" q="zz" rows={[]} />);
    expect(screen.queryByLabelText("طرف جديد")).toBeNull();
    expect(screen.getByText("لا نتائج مطابقة")).toBeTruthy();
  });
});

const profile: PartyProfile = {
  id: "c",
  version: 1,
  name: "محل النور",
  kind: "customer",
  code: "C-9",
  companyName: null,
  phones: ["0933 123 456"],
  email: null,
  city: "حلب",
  address: null,
  currency: "USD",
  creditLimit: null,
  notes: null,
  balances: [{ currency: "USD", balance: 20, side: "debit", totalDebit: 50, totalCredit: 30 }],
};

describe("party page", () => {
  it("balance, actions for its kind, documents that open", async () => {
    const onOpenDoc = vi.fn();
    const onNewVoucher = vi.fn();
    await render(
      <PartyDetailView
        party={profile}
        role="accountant"
        tab="invoices"
        docs={[
          {
            id: "i1",
            kind: "invoice",
            title: "فاتورة بيع",
            number: "INV-1",
            date: "2026-02-10",
            amount: 50,
            currency: "USD",
            note: "متبقي 30.00",
            cancelled: false,
          },
        ]}
        onTab={noop}
        onStatement={noop}
        onEdit={noop}
        onOpenDoc={onOpenDoc}
        onNewInvoice={noop}
        onNewVoucher={onNewVoucher}
      />,
    );
    expect(screen.getByTestId("balance-USD")).toBeTruthy();
    expect(screen.getByText("مدين (على العميل)")).toBeTruthy();
    expect(screen.getByText("متبقي 30.00")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("فاتورة بيع INV-1"));
    expect(onOpenDoc).toHaveBeenCalledOnce();
    await fireEvent.press(screen.getByLabelText("سند قبض"));
    expect(onNewVoucher).toHaveBeenCalledOnce();
  });

  it("a supplier offers a purchase invoice and a payment; a viewer neither", async () => {
    const base = {
      tab: "invoices" as const,
      docs: [],
      onTab: noop,
      onStatement: noop,
      onEdit: noop,
      onOpenDoc: noop,
      onNewInvoice: noop,
      onNewVoucher: noop,
    };
    await render(
      <PartyDetailView {...base} party={{ ...profile, kind: "supplier" }} role="admin" />,
    );
    expect(screen.getByLabelText("فاتورة دخول")).toBeTruthy();
    expect(screen.getByLabelText("سند صرف")).toBeTruthy();
    await render(<PartyDetailView {...base} party={profile} role="viewer" />);
    expect(screen.queryByLabelText("سند قبض")).toBeNull();
  });
});

describe("statement", () => {
  const data: StatementResult = {
    partyName: "محل النور",
    totals: [{ currency: "USD", previous: 50, debit: 0, credit: 30, closing: 20, side: "debit" }],
    entries: [
      {
        id: "e1",
        seq: 1,
        date: "2026-03-05",
        type: "receipt_in",
        status: "active",
        currency: "USD",
        referenceType: "voucher",
        referenceId: "v1",
        referenceNumber: "VOC-1",
        description: "",
        debit: 0,
        credit: 20,
        runningBalance: 30,
      },
      {
        id: "e2",
        seq: 2,
        date: "2026-03-10",
        type: "sales_return",
        status: "active",
        currency: "USD",
        referenceType: "return",
        referenceId: "r1",
        referenceNumber: "RET-1",
        description: "",
        debit: 0,
        credit: 10,
        runningBalance: 20,
      },
    ] as never,
  };
  const props = {
    partyName: "محل النور",
    kind: "customer" as const,
    currencies: ["USD", "SYP"],
    currency: "USD",
    period: "month" as const,
    from: "",
    to: "",
    data,
    loading: false,
    error: null,
    share: null,
    onCurrency: noop,
    onPeriod: noop,
    onDates: noop,
    onOpenEntry: noop,
    onRetry: noop,
  };

  it("previous balance, period debit/credit, closing with its side, lines with the desktop's names", async () => {
    await render(<StatementView {...props} />);
    expect(screen.getByText("50.00 USD")).toBeTruthy();
    expect(screen.getByText("الرصيد الختامي — مدين (على العميل)")).toBeTruthy();
    expect(screen.getByText("سند قبض VOC-1")).toBeTruthy();
    expect(screen.getByText("مرتجع بيع RET-1")).toBeTruthy();
    expect(screen.getByText("دائن 20.00")).toBeTruthy();
    expect(screen.getByText("الرصيد 20.00 USD")).toBeTruthy();
  });

  it("sharing the statement is in the footer, always in reach (not between the summary and the movements)", async () => {
    await render(<StatementView {...props} share={<View testID="share-slot" />} />);
    expect(within(screen.getByTestId("screen-footer")).getByTestId("share-slot")).toBeTruthy();
  });

  it("custom dates are checked", async () => {
    await render(<StatementView {...props} period="custom" from="2026-3-1" />);
    expect(screen.getByText("اكتب التاريخ بالشكل 2026-03-31")).toBeTruthy();
  });

  it("period presets", () => {
    const d = new Date(2026, 2, 15);
    expect(periodRange("month", d)).toEqual({ from: "2026-03-01", to: "2026-03-31" });
    expect(periodRange("lastMonth", d)).toEqual({ from: "2026-02-01", to: "2026-02-28" });
    expect(periodRange("year", d)).toEqual({ from: "2026-01-01", to: "2026-12-31" });
    expect(periodRange("all", d)).toEqual({ from: null, to: null });
  });

  it("the statement line names are the desktop's (ledgerCalc.ts)", () => {
    const desktop = readFileSync(
      path.resolve(__dirname, "../../../src/core/calculations/ledgerCalc.ts"),
      "utf8",
    );
    for (const [type, label] of Object.entries(STATEMENT_TYPE_LABEL)) {
      expect(desktop, type).toContain(`${type}: "${label}"`);
    }
  });
});

describe("party form", () => {
  it("a duplicate name gets the format hint", async () => {
    const message = "اسم العميل/المورد مستخدم مسبقاً — اختر اسماً مختلفاً أو افتح السجل الموجود.";
    await render(
      <PartyFormView
        title="عميل جديد"
        values={{ ...emptyPartyForm(), name: "زينب" }}
        error={message}
        onChange={noop}
        onSave={async () => undefined}
      />,
    );
    expect(screen.getByText(withNameHint(message))).toBeTruthy();
    expect(withNameHint(message)).toContain(NAME_HINT);
    expect(withNameHint("خطأ آخر")).toBe("خطأ آخر");
  });
});
