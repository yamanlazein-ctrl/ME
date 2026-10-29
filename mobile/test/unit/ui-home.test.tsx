import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { HomeView } from "../../src/ui/HomeView";
import type { HomeData } from "../../src/hooks/useDashboard";
import { visibleTabs } from "../../src/core/tabs";

const data = {
  dashboard: {
    cashbox: {
      balance: null,
      balanceByCurrency: { USD: 1250.5, SYP: 3_400_000 },
      todayMovementCount: 0,
      isLocked: false,
    },
    todaySales: { byCurrency: { USD: { total: 80, count: 2 } } },
    store: { name: "موتارد", city: "" },
    lowStockFabrics: 2,
    lowStockRolls: { low: 3, outOfStock: 1 },
    outstandingOrders: 0,
  },
  receivables: { USD: 10 },
  payables: { SYP: 500 },
} as unknown as HomeData;

const base = { loading: false, error: null, refreshing: false, onRefresh: () => undefined };

describe("Home (FR-09, FR-10)", () => {
  it("renders 1,250.50 USD and 3,400,000 SYP as two separate cards", async () => {
    await render(
      <HomeView {...base} data={data} role="admin" lastSyncAt={null} onAction={() => undefined} />,
    );
    expect(screen.getByTestId("cashbox-card-USD")).toBeTruthy();
    expect(screen.getByTestId("cashbox-card-SYP")).toBeTruthy();
    expect(screen.getByText("1,250.50 USD")).toBeTruthy();
    expect(screen.getByText("3,400,000.00 SYP")).toBeTruthy();
  });

  it("a viewer sees no write actions, an admin sees them", async () => {
    const onAction = vi.fn();
    await render(
      <HomeView {...base} data={data} role="viewer" lastSyncAt={null} onAction={onAction} />,
    );
    expect(screen.queryByLabelText("بيع جديد")).toBeNull();
    expect(screen.queryByLabelText("سند قبض")).toBeNull();
    expect(screen.getByLabelText("بحث عن طرف")).toBeTruthy();
  });

  it("an accountant can start a sale", async () => {
    const onAction = vi.fn();
    await render(
      <HomeView {...base} data={data} role="accountant" lastSyncAt={null} onAction={onAction} />,
    );
    await fireEvent.press(screen.getByLabelText("بيع جديد"));
    expect(onAction).toHaveBeenCalledWith("sale");
  });

  it("today's sales, what is owed both ways, and the stock alert that opens the inventory", async () => {
    const onAction = vi.fn();
    await render(
      <HomeView {...base} data={data} role="admin" lastSyncAt={null} onAction={onAction} />,
    );
    expect(screen.getByText("2 فاتورة")).toBeTruthy();
    expect(screen.getByText("80.00 USD")).toBeTruthy();
    expect(screen.getByText("لنا على العملاء — USD")).toBeTruthy();
    expect(screen.getByText("500.00 SYP")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("2 قماش تحت الحد الأدنى"));
    expect(onAction).toHaveBeenCalledWith("inventory");
  });

  it("an error offers a retry", async () => {
    const onRefresh = vi.fn();
    await render(
      <HomeView
        {...base}
        data={undefined}
        error={new Error("x")}
        onRefresh={onRefresh}
        role="admin"
        lastSyncAt={null}
        onAction={() => undefined}
      />,
    );
    await fireEvent.press(screen.getByLabelText("إعادة المحاولة"));
    expect(onRefresh).toHaveBeenCalled();
  });

  it("the add tab is hidden for read-only roles", () => {
    expect(visibleTabs("viewer").map((t) => t.name)).not.toContain("add");
    expect(visibleTabs("warehouse").map((t) => t.name)).not.toContain("add");
    expect(visibleTabs("admin").map((t) => t.name)).toContain("add");
  });
});
