import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react-native";
import {
  emptyEntryDraft,
  entryProblems,
  entryTotals,
  toEntryInput,
  type EntryDraft,
} from "../../src/core/entryDraft";
import { EntryFormView } from "../../src/ui/EntryViews";
import { withQuery } from "../helpers/withQuery";

vi.mock("../../src/hooks/useParties", () => ({ usePartyList: () => ({ data: [] }) }));

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
    expect(entryProblems(emptyEntryDraft())).toEqual(["no-supplier", "no-lines"]);
    expect(entryProblems(draft({ currency: "SYP", exchangeRate: null }))).toEqual(["no-rate"]);
    expect(entryProblems(draft({ currency: "SYP", exchangeRate: 150 }))).toEqual(["bad-rate"]);
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

describe("entry form", () => {
  const props = (d: EntryDraft) => ({
    draft: d,
    error: null as string | null,
    onSupplier: () => undefined,
    onCurrency: () => undefined,
    onRate: () => undefined,
    onAddLine: () => undefined,
    onRemoveLine: () => undefined,
    onPatch: () => undefined,
    onDiscard: () => undefined,
    onSave: vi.fn(async () => undefined),
  });

  it("shows lines with new-fabric marks and the amount due; saves when complete", async () => {
    const p = { ...props(draft({ paid: 5 })), error: "خطأ" };
    await render(withQuery(<EntryFormView {...p} />));
    expect(screen.getByText("قطن · أحمر")).toBeTruthy();
    expect(screen.getByText("قماش جديد")).toBeTruthy();
    expect(screen.getByText("المتبقي للمورد")).toBeTruthy();
    expect(screen.getByText("20.00 USD")).toBeTruthy();
    expect(screen.getByText("خطأ")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("حفظ الفاتورة"));
    expect(p.onSave).toHaveBeenCalledOnce();
  });

  it("an empty draft names its problems and does not save", async () => {
    const p = props(emptyEntryDraft());
    await render(withQuery(<EntryFormView {...p} />));
    await fireEvent.press(screen.getByLabelText("حفظ الفاتورة"));
    expect(screen.getByTestId("entry-problems")).toBeTruthy();
    expect(p.onSave).not.toHaveBeenCalled();
  });
});
