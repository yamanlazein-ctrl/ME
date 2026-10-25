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
  },
  receivables: { USD: 10 },
  payables: { SYP: 500 },
} as unknown as HomeData;

describe("Home (FR-09, FR-10)", () => {
  it("renders 1,250.50 USD and 3,400,000 SYP as two separate cards", async () => {
    await render(
      <HomeView data={data} role="admin" lastSyncAt={null} onAction={() => undefined} />,
    );
    expect(screen.getByTestId("cashbox-card-USD")).toBeTruthy();
    expect(screen.getByTestId("cashbox-card-SYP")).toBeTruthy();
    expect(screen.getByText("1,250.50 USD")).toBeTruthy();
    expect(screen.getByText("3,400,000.00 SYP")).toBeTruthy();
  });

  it("a viewer sees no write actions, an admin sees them", async () => {
    const onAction = vi.fn();
    await render(<HomeView data={data} role="viewer" lastSyncAt={null} onAction={onAction} />);
    expect(screen.queryByLabelText("بيع جديد")).toBeNull();
    expect(screen.queryByLabelText("سند قبض")).toBeNull();
    expect(screen.getByLabelText("بحث عن طرف")).toBeTruthy();
  });

  it("an accountant can start a sale", async () => {
    const onAction = vi.fn();
    await render(<HomeView data={data} role="accountant" lastSyncAt={null} onAction={onAction} />);
    await fireEvent.press(screen.getByLabelText("بيع جديد"));
    expect(onAction).toHaveBeenCalledWith("sale");
  });

  it("the add tab is hidden for read-only roles", () => {
    expect(visibleTabs("viewer").map((t) => t.name)).not.toContain("add");
    expect(visibleTabs("warehouse").map((t) => t.name)).not.toContain("add");
    expect(visibleTabs("admin").map((t) => t.name)).toContain("add");
  });
});
