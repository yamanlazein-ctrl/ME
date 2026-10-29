import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { CONFLICT_NOTE } from "../../src/core/orders";
import { emptyReturnDraft, RETURN_REASON_LABEL } from "../../src/core/returns";
import { OrderDetailView, OrderListView } from "../../src/ui/OrderViews";
import { ReturnFormView, ReturnListView } from "../../src/ui/ReturnViews";

vi.mock("../../src/hooks/useParties", () => ({ useParties: () => ({ data: [] }) }));

const order = (status: string) =>
  ({
    id: "o1",
    code: "ORD-1",
    customerNameSnapshot: "عميل",
    date: "2026-03-01",
    status,
    version: 2,
    items: [{ id: "i1", fabricName: "قطن", colorName: "بني", requestedKg: 50 }],
  }) as never;

describe("order views", () => {
  it("the list opens an order and offers 'new' only to writers", async () => {
    const onOpen = vi.fn();
    const rows = [
      {
        id: "o1",
        code: "ORD-1",
        customer: "عميل",
        date: "2026-03-01",
        status: "open",
        version: 1,
        totalKg: 50,
      },
    ];
    await render(
      <OrderListView rows={rows} canWrite={false} onOpen={onOpen} onNew={() => undefined} />,
    );
    expect(screen.queryByText("طلبية جديدة")).toBeNull();
    fireEvent.press(screen.getByLabelText("طلبية ORD-1"));
    expect(onOpen).toHaveBeenCalledWith("o1");
  });

  it("detail shows pending conflicts read-only with the desktop note, and cancel / fulfil while active", async () => {
    const detail = {
      order: order("open"),
      conflicts: [{ orderId: "o2", code: "ORD-2", customer: "آخر", items: ["قطن · بني · 20 كغ"] }],
    };
    const onCancel = vi.fn();
    await render(
      <OrderDetailView
        detail={detail}
        canWrite
        candidates={[{ id: "inv1", number: "INV-1", date: "2026-03-02" }]}
        error={null}
        onCancel={onCancel}
        onFulfil={() => undefined}
      />,
    );
    expect(screen.getByText(CONFLICT_NOTE)).toBeTruthy();
    expect(screen.getByText("تنفيذ بالفاتورة INV-1")).toBeTruthy();
    fireEvent.press(screen.getByText("إلغاء الطلبية"));
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("a fulfilled order offers neither cancel nor fulfil", async () => {
    await render(
      <OrderDetailView
        detail={{ order: order("fulfilled"), conflicts: [] }}
        canWrite
        candidates={[]}
        error={null}
        onCancel={() => undefined}
        onFulfil={() => undefined}
      />,
    );
    expect(screen.queryByText("إلغاء الطلبية")).toBeNull();
  });
});

describe("return views", () => {
  it("the form names what blocks saving and lists the reasons", async () => {
    await render(
      <ReturnFormView
        draft={emptyReturnDraft("sale")}
        invoices={[]}
        busy={false}
        error={null}
        onKind={() => undefined}
        onParty={() => undefined}
        onInvoice={() => undefined}
        onQty={() => undefined}
        onReason={() => undefined}
        onSave={() => undefined}
      />,
    );
    expect(screen.getByText("اختر الطرف")).toBeTruthy();
    expect(screen.getByText(RETURN_REASON_LABEL.defect)).toBeTruthy();
  });

  it("the list offers cancel on an active return to allowed roles", async () => {
    const rows = [
      {
        id: "r1",
        number: "RET-1",
        kind: "sale",
        date: "2026-03-01",
        status: "active",
        version: 1,
        total: 130,
        currency: "USD",
      },
      {
        id: "r2",
        number: "RET-2",
        kind: "sale",
        date: "2026-03-01",
        status: "cancelled",
        version: 2,
        total: 5,
        currency: "USD",
      },
    ];
    const onCancel = vi.fn();
    await render(<ReturnListView rows={rows} canCancel error={null} onCancel={onCancel} />);
    fireEvent.press(screen.getByLabelText("إلغاء المرتجع RET-1"));
    expect(onCancel).toHaveBeenCalledWith(rows[0]);
    expect(screen.getByText("ملغى")).toBeTruthy();
  });

  it("a viewer sees no cancel button", async () => {
    const rows = [
      {
        id: "r1",
        number: "RET-1",
        kind: "sale",
        date: "2026-03-01",
        status: "active",
        version: 1,
        total: 130,
        currency: "USD",
      },
    ];
    await render(
      <ReturnListView rows={rows} canCancel={false} error={null} onCancel={() => undefined} />,
    );
    expect(screen.queryByLabelText("إلغاء المرتجع RET-1")).toBeNull();
  });
});
