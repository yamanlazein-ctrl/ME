import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react-native";
import {
  emptyEntryDraft,
  entryProblems,
  entryTotals,
  toEntryInput,
  type EntryDraft,
} from "../../src/core/entryDraft";
import { EntryReviewView } from "../../src/ui/EntryViews";

vi.mock("../../src/hooks/useParties", () => ({ useParties: () => ({ data: [] }) }));

const draft = (patch: Partial<EntryDraft> = {}): EntryDraft => ({
  ...emptyEntryDraft(),
  supplier: { id: "s1", name: "مورد" },
  exchangeRate: 1,
  lines: [
    { key: "k1", fabricName: "قطن", colorName: "أحمر", quantityKg: 10, pieces: 1, pricePerKg: 2.5 },
  ],
  ...patch,
});

describe("entry draft", () => {
  it("totals use the shared invoice formula (subtotal - discount + tax + shipping) and the due amount", () => {
    const d = draft({ discount: 5, tax: 2, shipping: 3, paid: 10 });
    expect(entryTotals(d)).toEqual({ subtotal: 25, total: 25, due: 15 });
  });

  it("names every problem that blocks saving", () => {
    expect(entryProblems(draft())).toEqual([]);
    expect(entryProblems(emptyEntryDraft())).toEqual(["no-supplier", "no-rate", "no-lines"]);
    expect(
      entryProblems(
        draft({
          lines: [
            { key: "k", fabricName: "", colorName: "x", quantityKg: 0, pieces: 0, pricePerKg: 1 },
          ],
        }),
      ),
    ).toEqual(["bad-line"]);
  });

  it("builds the use-case input without the UI keys", () => {
    const input = toEntryInput(draft({ paid: 4 }), "2026-03-01");
    expect(input).toMatchObject({ supplierId: "s1", currency: "USD", exchangeRate: 1, paid: 4 });
    expect(input.lines[0]).not.toHaveProperty("key");
    expect(() => toEntryInput(emptyEntryDraft(), "2026-03-01")).toThrow();
  });
});

describe("entry review view", () => {
  it("shows the totals, blocks saving with problems and saves when complete", async () => {
    const onSave = vi.fn();
    const { rerender } = await render(
      <EntryReviewView
        draft={emptyEntryDraft()}
        busy={false}
        error={null}
        onPatch={() => undefined}
        onSave={onSave}
      />,
    );
    expect(screen.getByText("اختر المورد")).toBeTruthy();
    await rerender(
      <EntryReviewView
        draft={draft()}
        busy={false}
        error="خطأ"
        onPatch={() => undefined}
        onSave={onSave}
      />,
    );
    expect(screen.getByText("المتبقي للمورد")).toBeTruthy();
    expect(screen.getByText("خطأ")).toBeTruthy();
    fireEvent.press(screen.getByText("حفظ فاتورة الشراء"));
    expect(onSave).toHaveBeenCalledOnce();
  });
});
