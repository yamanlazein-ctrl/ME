import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react-native";
import type { FabricStock, LotDetail } from "../../src/core/stock";
import {
  ColorLotsView,
  CountSheetView,
  FabricView,
  LOW_STOCK_TEXT,
  LotView,
  StockListView,
} from "../../src/ui/InventoryViews";

const fabric = (over: Partial<FabricStock> = {}): FabricStock => ({
  id: "f1",
  name: "قطن",
  category: "قمصان",
  unit: "kg",
  minStockKg: 50,
  remainingKg: 32,
  pieces: 4,
  activeLots: 2,
  colorCount: 3,
  low: true,
  ...over,
});

const listProps = {
  q: "",
  filter: "all" as const,
  category: null,
  categories: ["قمصان"],
  lots: [],
  loading: false,
  error: null,
  refreshing: false,
  canCount: true,
  onQuery: () => undefined,
  onFilter: () => undefined,
  onCategory: () => undefined,
  onRefresh: () => undefined,
  onRetry: () => undefined,
  onOpenFabric: () => undefined,
  onOpenLot: () => undefined,
  onCount: () => undefined,
};

describe("stock list", () => {
  it("each fabric shows kg, pieces, colours, available lots and the low-stock badge", async () => {
    await render(<StockListView {...listProps} rows={[fabric()]} />);
    expect(screen.getByText("32.00 كغ")).toBeTruthy();
    expect(screen.getByText("4 ثوب")).toBeTruthy();
    expect(screen.getByText("قمصان · 3 لون · 2 صبغة متوفرة")).toBeTruthy();
    expect(screen.getByText(LOW_STOCK_TEXT)).toBeTruthy();
  });

  it("an empty fabric says it ran out; no badge when above the minimum", async () => {
    await render(
      <StockListView
        {...listProps}
        rows={[
          fabric({ id: "a", remainingKg: 0, low: true }),
          fabric({ id: "b", name: "كتان", remainingKg: 80, low: false }),
        ]}
      />,
    );
    expect(screen.getAllByText("نفد")).toHaveLength(2); // the filter chip and the badge
    expect(screen.queryByText(LOW_STOCK_TEXT)).toBeNull();
  });

  it("search matches on dye lots open the lot directly", async () => {
    const onOpenLot = vi.fn();
    await render(
      <StockListView
        {...listProps}
        q="DL-1"
        rows={[]}
        lots={[
          {
            id: "r1",
            rollNo: "DL-1",
            fabricId: "f1",
            fabricName: "قطن",
            colorName: "أبيض",
            remainingKg: 12,
            remainingPieces: 1,
          },
        ]}
        onOpenLot={onOpenLot}
      />,
    );
    await fireEvent.press(screen.getByLabelText("صبغة DL-1"));
    expect(onOpenLot).toHaveBeenCalledWith("r1");
    expect(screen.getByText("لا نتائج مطابقة")).toBeTruthy();
  });

  it("loading, error with retry, and the count button only for writers", async () => {
    const onRetry = vi.fn();
    await render(<StockListView {...listProps} rows={undefined} loading />);
    expect(screen.getByTestId("state-loading")).toBeTruthy();
    await render(
      <StockListView
        {...listProps}
        rows={undefined}
        error={new Error("x")}
        onRetry={onRetry}
        canCount={false}
      />,
    );
    await fireEvent.press(screen.getByLabelText("إعادة المحاولة"));
    expect(onRetry).toHaveBeenCalledOnce();
    expect(screen.queryByLabelText("جرد المخزون")).toBeNull();
  });
});

describe("fabric, colour and lot", () => {
  it("fabric: totals, minimum warning, colours with code and lots", async () => {
    const onOpenColor = vi.fn();
    await render(
      <FabricView
        detail={{
          fabric: { ...fabric(), notes: null },
          colors: [
            {
              id: "c1",
              name: "أبيض",
              code: "W-1",
              hex: "#ffffff",
              remainingKg: 32,
              pieces: 4,
              activeLots: 2,
              totalLots: 3,
            },
          ],
        }}
        onOpenColor={onOpenColor}
      />,
    );
    expect(screen.getByText("الرصيد أقل من الحد الأدنى لهذا القماش.")).toBeTruthy();
    expect(screen.getByText("رقم اللون W-1 · 2 من 3 صبغة متوفرة")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("أبيض"));
    expect(onOpenColor).toHaveBeenCalledWith("c1");
  });

  it("colour: available lots by default, all on request, with supplier and state", async () => {
    const lots = [
      {
        id: "r1",
        rollNo: "DL-1",
        dyeBatch: null,
        initialKg: 50,
        remainingKg: 30,
        remainingPieces: 2,
        pieces: 3,
        supplierName: "معمل",
        entryDate: "2026-02-01",
        state: "active" as const,
      },
      {
        id: "r2",
        rollNo: "DL-2",
        dyeBatch: null,
        initialKg: 40,
        remainingKg: 0,
        remainingPieces: 0,
        pieces: 2,
        supplierName: null,
        entryDate: null,
        state: "out" as const,
      },
    ];
    await render(
      <ColorLotsView
        data={{
          fabricId: "f1",
          fabricName: "قطن",
          fabricMinKg: 0,
          colorName: "أبيض",
          colorCode: null,
          hex: null,
          lots,
        }}
        onOpenLot={() => undefined}
      />,
    );
    expect(screen.getByText("صبغة DL-1")).toBeTruthy();
    expect(screen.queryByText("صبغة DL-2")).toBeNull();
    expect(screen.getByText("معمل · 2026-02-01")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("الكل (2)"));
    expect(screen.getByText("صبغة DL-2")).toBeTruthy();
    expect(screen.getByText("منتهية")).toBeTruthy();
  });

  const lot: LotDetail = {
    id: "r1",
    rollNo: "DL-1",
    version: 3,
    fabricId: "f1",
    fabricName: "قطن",
    colorId: "c1",
    colorName: "أبيض",
    colorCode: "W-1",
    dyeBatch: "B7",
    initialKg: 50,
    remainingKg: 30,
    outKg: 20,
    pieces: 3,
    remainingPieces: 2,
    widthCm: 150,
    weightGsm: null,
    salePricePerKg: 4.5,
    costPerKg: 3,
    currency: "USD",
    entryPricePerKg: null,
    entryCurrency: null,
    supplierName: "معمل",
    entryDate: "2026-02-01",
    entryReference: null,
    state: "active",
    movements: [
      {
        id: "m1",
        label: "فاتورة بيع",
        direction: "out",
        quantityKg: 20,
        balanceAfterKg: 30,
        date: "2026-02-03",
        reference: "INV-1",
        referenceType: "invoice",
        referenceId: "i1",
        cancelled: false,
      },
    ],
  };

  it("lot: quantities, specs, supplier, prices and movements with the balance after; invoice opens", async () => {
    const onOpenReference = vi.fn();
    await render(
      <LotView
        lot={lot}
        role="viewer"
        error={null}
        notice={null}
        onAdjust={async () => undefined}
        onOpenReference={onOpenReference}
      />,
    );
    expect(screen.getByText("30.00 كغ")).toBeTruthy();
    expect(screen.getByText("2 من 3")).toBeTruthy();
    expect(screen.getByText("150 سم")).toBeTruthy();
    expect(screen.getByText("معمل")).toBeTruthy();
    expect(screen.getByText("4.50 USD")).toBeTruthy();
    expect(screen.getByText("−20.00 كغ")).toBeTruthy();
    expect(screen.getByText("الرصيد 30.00 كغ")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("فاتورة بيع"));
    expect(onOpenReference).toHaveBeenCalledOnce();
    expect(screen.queryByLabelText("تعديل الكمية")).toBeNull();
  });

  it("lot: admins open the adjust form; the error shows there", async () => {
    await render(
      <LotView
        lot={lot}
        role="admin"
        error="الكمية غير صالحة"
        notice={null}
        onAdjust={async () => undefined}
        onOpenReference={() => undefined}
      />,
    );
    await fireEvent.press(screen.getByLabelText("تعديل الكمية"));
    expect(screen.getByText("الكمية غير صالحة")).toBeTruthy();
    expect(screen.getByLabelText("حفظ التعديل").props.accessibilityState.disabled).toBe(true);
  });
});

describe("count sheet", () => {
  it("posts a variance only for a counted line with a difference", async () => {
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
    expect(screen.getByText("18.00 كغ")).toBeTruthy();
    expect(screen.getByText("−2.00 كغ")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("ترحيل الفرق R-1"));
    expect(onPost).toHaveBeenCalledOnce();
  });
});
