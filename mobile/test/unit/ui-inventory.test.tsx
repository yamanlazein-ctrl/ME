import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react-native";
import { isLowStock } from "../../src/core/inventory";
import {
  CountSheetView,
  FabricListView,
  LOW_STOCK_TEXT,
  RollDetailView,
} from "../../src/ui/InventoryViews";

const fabric = (remainingKg: number) => ({
  id: "f1",
  name: "قطن",
  minStockKg: 50,
  remainingKg,
  rollCount: 2,
  low: isLowStock(remainingKg, 50),
});

describe("inventory views", () => {
  it("shows the low-stock badge when 32 kg remain of a 50 kg minimum, and not at 60 kg", async () => {
    const { rerender } = await render(
      <FabricListView
        rows={[fabric(32)]}
        q=""
        role="admin"
        onQuery={() => undefined}
        onOpen={() => undefined}
        onCount={() => undefined}
      />,
    );
    expect(screen.getByText(LOW_STOCK_TEXT)).toBeTruthy();
    expect(screen.getByText("32.00 كغ · 2 لفة")).toBeTruthy();
    await rerender(
      <FabricListView
        rows={[fabric(60)]}
        q=""
        role="admin"
        onQuery={() => undefined}
        onOpen={() => undefined}
        onCount={() => undefined}
      />,
    );
    expect(screen.queryByText(LOW_STOCK_TEXT)).toBeNull();
  });

  it("the count button is for admin and accountant only", async () => {
    const props = {
      rows: [fabric(60)],
      q: "",
      onQuery: () => undefined,
      onOpen: () => undefined,
      onCount: () => undefined,
    };
    const { rerender } = await render(<FabricListView {...props} role="warehouse" />);
    expect(screen.queryByText("جرد المخزون")).toBeNull();
    await rerender(<FabricListView {...props} role="accountant" />);
    expect(screen.getByText("جرد المخزون")).toBeTruthy();
  });

  const detail = {
    roll: {
      id: "r1",
      rollNo: "R-1",
      remainingKg: 20,
      remainingPieces: 2,
      pricePerKg: 3,
      currency: "USD",
      status: "in_stock",
      version: 1,
      initialKg: 20,
      entryDate: "2026-01-05",
      dyeBatch: null,
    },
    fabricName: "قطن",
    colorName: "أزرق",
    movements: [
      { id: "m1", type: "adjustment", deltaKg: -2, date: "2026-02-01", reference: "ADJ-1" },
    ],
  };

  it("roll detail shows the movements, and the adjust form only for allowed roles", async () => {
    const onAdjust = vi.fn();
    const { rerender } = await render(
      <RollDetailView
        detail={detail}
        role="viewer"
        error={null}
        busy={false}
        onAdjust={onAdjust}
      />,
    );
    expect(screen.getByText("2026-02-01 · ADJ-1 · -2.00 كغ")).toBeTruthy();
    expect(screen.queryByText("تعديل الكمية")).toBeNull();
    await rerender(
      <RollDetailView detail={detail} role="admin" error="خطأ" busy={false} onAdjust={onAdjust} />,
    );
    expect(screen.getByText("تعديل الكمية")).toBeTruthy();
    expect(screen.getByText("خطأ")).toBeTruthy();
  });

  it("count sheet posts a variance only for a counted line with a difference", async () => {
    const onPost = vi.fn();
    await render(
      <CountSheetView
        lines={[
          {
            rollId: "r1",
            countId: "c1",
            rollNo: "R-1",
            fabricName: "قطن",
            colorName: "أزرق",
            bookKg: 20,
            countedKg: 18,
            diffKg: -2,
            status: "counted",
          },
        ]}
        total={1}
        q=""
        error={null}
        notice={null}
        onQuery={() => undefined}
        onRecord={() => undefined}
        onPost={onPost}
      />,
    );
    expect(screen.getByText("المعدود: 18.00 كغ · الفرق: -2.00")).toBeTruthy();
    fireEvent.press(screen.getByLabelText("ترحيل الفرق R-1"));
    expect(onPost).toHaveBeenCalledOnce();
  });
});
