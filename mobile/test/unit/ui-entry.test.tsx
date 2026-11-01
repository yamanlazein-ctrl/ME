import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen, within } from "@testing-library/react-native";
import { parseInvoiceNotes, parseLineNote } from "@web/components/print/noteParser";
import {
  copyOfLine,
  emptyEntryDraft,
  entryProblems,
  entryTotals,
  lineProblems,
  toEntryInput,
  type EntryDraft,
} from "../../src/core/entryDraft";
import { buildEntryLineNote, buildInvoiceNotes } from "../../src/core/lineNote";
import type { EntryLineInput } from "../../src/core/documents";
import { EntryFormView, EntryLineView, LINE_FIELD_ORDER } from "../../src/ui/EntryViews";
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

describe("purchase line note: the desktop's format, read back by the desktop's own parser", () => {
  it("writes every production detail so the desktop invoice page and print show them", () => {
    const note = buildEntryLineNote({
      reference: "M-7",
      source: "حلب",
      machineNo: "12",
      kromaj: "180",
      draw: "3",
      grossKg: 52.5,
      note: "بدون كرتون",
    });
    // The exact string the desktop's purchase form builds (src/routes/invoices.entry.new.tsx).
    expect(note).toBe(
      "مرجعية: M-7 • مصدر: حلب • رقم الماكينة: 12 • كراماج: 180 • السحب: 3 • وزن قائم: 52.5 • بدون كرتون",
    );
    expect(parseLineNote(note)).toMatchObject({
      reference: "M-7",
      source: "حلب",
      machineNo: "12",
      chromaj: "180",
      draw: "3",
      grossKg: "52.5",
      freeText: "بدون كرتون",
    });
  });

  it("writes nothing when there are no details, and a «•» typed in a field cannot break the note", () => {
    expect(buildEntryLineNote({})).toBeUndefined();
    expect(buildEntryLineNote({ grossKg: 0, kromaj: "  " })).toBeUndefined();
    expect(parseLineNote(buildEntryLineNote({ machineNo: "1 • 2", kromaj: "180" }))).toMatchObject({
      machineNo: "1 2",
      chromaj: "180",
    });
  });

  it("invoice notes carry the supplier's number and the payment method like the desktop's", () => {
    const notes = buildInvoiceNotes({ reference: "F-99", paymentMethod: "transfer" });
    expect(notes).toBe("المرجع: F-99 • طريقة الدفع: تحويل بنكي");
    expect(parseInvoiceNotes(notes)).toMatchObject({
      reference: "F-99",
      paymentMethod: "تحويل بنكي",
    });
  });
});

describe("purchase draft", () => {
  it("totals: line discounts count, plus kg and pieces like the desktop's totals block", () => {
    const d = draft({
      discount: 5,
      tax: 2,
      shipping: 3,
      paid: 10,
      lines: [
        {
          key: "a",
          fabricName: "قطن",
          colorName: "أحمر",
          quantityKg: 10,
          pieces: 2,
          pricePerKg: 2.5,
          discountAmount: 1,
        },
        {
          key: "b",
          fabricName: "قطن",
          colorName: "أزرق",
          quantityKg: 4.5,
          pieces: 1,
          pricePerKg: 2,
        },
      ],
    });
    expect(entryTotals(d)).toEqual({ subtotal: 33, total: 33, due: 23, kg: 14.5, pieces: 3 });
  });

  it("names every problem that blocks saving", () => {
    expect(entryProblems(draft())).toEqual([]);
    expect(entryProblems(emptyEntryDraft())).toEqual(["no-supplier", "no-lines"]);
    expect(entryProblems(draft({ currency: "SYP", exchangeRate: null }))).toEqual(["no-rate"]);
    expect(entryProblems(draft({ currency: "SYP", exchangeRate: 150 }))).toEqual(["bad-rate"]);
    expect(entryProblems(draft({ date: "2026-3-1" }))).toEqual(["bad-date"]);
    expect(entryProblems(draft({ paid: 26 }))).toEqual(["paid-over-total"]);
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

  it("line rules: required names, net kg and price; discount within the line; gross not under net", () => {
    const ok: EntryLineInput = {
      fabricName: "قطن",
      colorName: "أحمر",
      quantityKg: 10,
      pieces: 1,
      pricePerKg: 2,
    };
    expect(lineProblems(ok)).toEqual([]);
    expect(
      lineProblems({ ...ok, fabricName: " ", colorName: "", quantityKg: 0, pricePerKg: 0 }),
    ).toEqual(["no-fabric", "no-color", "no-kg", "no-price"]);
    expect(lineProblems({ ...ok, discountAmount: 21 })).toEqual(["discount-over"]);
    expect(lineProblems({ ...ok, details: { grossKg: 9 } })).toEqual(["gross-under"]);
    expect(lineProblems({ ...ok, details: { grossKg: 10.4 } })).toEqual([]);
  });

  it("builds the use-case input: chosen date, supplier's number, payment method, no UI keys", () => {
    const input = toEntryInput(
      draft({ paid: 4, date: "2026-02-28", reference: " F-1 ", paymentMethod: "check" }),
      "2026-03-01",
    );
    expect(input).toMatchObject({
      supplierId: "s1",
      currency: "USD",
      exchangeRate: 1,
      paid: 4,
      date: "2026-02-28",
      reference: "F-1",
      paymentMethod: "check",
    });
    expect(input.lines[0]).not.toHaveProperty("key");
    expect(toEntryInput(draft(), "2026-03-01").date).toBe("2026-03-01");
    expect(() => toEntryInput(emptyEntryDraft(), "2026-03-01")).toThrow();
  });

  it("the next roll of the same delivery keeps names, price, details and specs; not its weights or dye", () => {
    const next = copyOfLine({
      fabricId: "f",
      fabricName: "قطن",
      colorId: "c",
      colorName: "أحمر",
      dyeBatch: "D1",
      quantityKg: 10,
      pieces: 2,
      pricePerKg: 3,
      discountAmount: 1,
      details: { machineNo: "4", kromaj: "180", grossKg: 11 },
      widthCm: 180,
      weightGsm: 200,
    });
    expect(next).toEqual({
      fabricId: "f",
      fabricName: "قطن",
      colorId: "c",
      colorName: "أحمر",
      pricePerKg: 3,
      details: { machineNo: "4", kromaj: "180" },
      widthCm: 180,
      weightGsm: 200,
    });
  });
});

describe("purchase invoice page", () => {
  const props = (d: EntryDraft) => ({
    draft: d,
    error: null as string | null,
    today: "2026-03-01",
    onSupplier: () => undefined,
    onCurrency: () => undefined,
    onRate: () => undefined,
    onAddLine: vi.fn(),
    onCopyLine: vi.fn(),
    onEditLine: vi.fn(),
    onRemoveLine: vi.fn(),
    onPatch: vi.fn(),
    onDiscard: () => undefined,
    onSave: vi.fn(async () => undefined),
  });

  it("header like the desktop (supplier's number, date), lines with details, totals with kg and pieces", async () => {
    const p = {
      ...props(
        draft({
          paid: 5,
          lines: [
            {
              key: "k1",
              fabricName: "قطن",
              colorName: "أحمر",
              quantityKg: 10,
              pieces: 3,
              pricePerKg: 2.5,
              dyeBatch: "D-4",
              details: { grossKg: 10.6, kromaj: "180" },
            },
          ],
        }),
      ),
      error: "خطأ",
    };
    await render(withQuery(<EntryFormView {...p} />));
    expect(screen.getByLabelText("رقم الفاتورة")).toBeTruthy();
    expect(screen.getByLabelText("التاريخ").props.placeholder).toBe("2026-03-01");
    expect(screen.getByText("قطن · أحمر")).toBeTruthy();
    expect(screen.getByText(/قائم 10.60 كغ/)).toBeTruthy();
    expect(screen.getByText(/كراماج 180/)).toBeTruthy();
    expect(screen.getByText("قماش جديد", { exact: false })).toBeTruthy();
    expect(screen.getByTestId("entry-footer-qty").props.children).toBe("10.00 كغ · 3 ثوب");
    expect(screen.getByText("المتبقي للمورد")).toBeTruthy();
    expect(screen.getByText("20.00 USD")).toBeTruthy();
    // Something paid: the payment method is asked, like the desktop's «الدفع».
    expect(screen.getByTestId("entry-method-transfer")).toBeTruthy();
    expect(screen.getByText("خطأ")).toBeTruthy();
    await fireEvent.press(screen.getByLabelText("حفظ الفاتورة"));
    expect(p.onSave).toHaveBeenCalledOnce();
  });

  it("a line opens edit / same fabric and colour / delete", async () => {
    const p = props(draft());
    await render(withQuery(<EntryFormView {...p} />));
    await fireEvent.press(screen.getByLabelText("بند قطن أحمر"));
    await fireEvent.press(screen.getByTestId("entry-line-edit"));
    expect(p.onEditLine).toHaveBeenCalledWith("k1");
    await fireEvent.press(screen.getByLabelText("بند قطن أحمر"));
    await fireEvent.press(screen.getByTestId("entry-line-copy"));
    expect(p.onCopyLine).toHaveBeenCalledWith("k1");
  });

  it("an empty draft names its problems and does not save", async () => {
    const p = props(emptyEntryDraft());
    await render(withQuery(<EntryFormView {...p} />));
    await fireEvent.press(screen.getByLabelText("حفظ الفاتورة"));
    expect(screen.getByTestId("entry-problems")).toBeTruthy();
    expect(p.onSave).not.toHaveBeenCalled();
  });
});

describe("purchase line page", () => {
  it("has the desktop line card's sections and fields", async () => {
    await render(
      withQuery(
        <EntryLineView currency="USD" editing={false} onSave={vi.fn()} onCancel={vi.fn()} />,
      ),
    );
    for (const title of [
      "بيانات القماش",
      "بيانات الإنتاج",
      "بيانات اللون",
      "بيانات الوزن",
      "بيانات الصباغة",
      "بيانات الشراء",
    ]) {
      expect(screen.getByText(title)).toBeTruthy();
    }
    for (const label of [
      "المرجعية",
      "المصدر",
      "الأثواب",
      "رقم الماكينة",
      "كراماج",
      "السحب",
      "رقم اللون",
      "الوزن القائم (كغ)",
      "الوزن الصافي (كغ) *",
      "رقم الصبغة",
      "السعر / كغ (USD) *",
      "الخصم (مبلغ)",
    ]) {
      expect(screen.getByLabelText(label)).toBeTruthy();
    }
    await fireEvent.press(screen.getByTestId("entry-specs"));
    expect(screen.getByLabelText("العرض (سم)")).toBeTruthy();
    expect(screen.getByLabelText("الغراماج (غ/م²)")).toBeTruthy();
    expect(screen.getByLabelText("سعر البيع / كغ (USD)")).toBeTruthy();
  });

  it("«التالي» on the keyboard walks the fields in the desktop's order", async () => {
    await render(
      withQuery(
        <EntryLineView currency="USD" editing={false} onSave={vi.fn()} onCancel={vi.fn()} />,
      ),
    );
    expect(LINE_FIELD_ORDER.slice(0, 4)).toEqual([
      "entry-fabric",
      "entry-reference",
      "entry-source",
      "entry-pieces",
    ]);
    for (const id of ["entry-fabric", "entry-kromaj", "entry-gross", "entry-kg", "entry-price"]) {
      const input = screen.getByTestId(id);
      expect(input.props.returnKeyType, id).toBe("next");
      expect(typeof input.props.onSubmitEditing, id).toBe("function");
    }
  });

  it("saves the line with its details; «حفظ وبند جديد» asks for the next one", async () => {
    const onSave = vi.fn();
    await render(
      withQuery(
        <EntryLineView currency="USD" editing={false} onSave={onSave} onCancel={vi.fn()} />,
      ),
    );
    await fireEvent.press(screen.getByTestId("entry-line-save"));
    expect(screen.getByTestId("entry-line-problems")).toBeTruthy();
    expect(onSave).not.toHaveBeenCalled();
    await fireEvent.changeText(screen.getByLabelText("نوع القماش *"), "قطن");
    await fireEvent.changeText(screen.getByLabelText("اسم اللون *"), "أبيض");
    await fireEvent.changeText(screen.getByLabelText("رقم اللون"), "W-1");
    await fireEvent.changeText(screen.getByLabelText("الأثواب"), "4");
    await fireEvent.changeText(screen.getByLabelText("كراماج"), "180");
    await fireEvent.changeText(screen.getByLabelText("الوزن القائم (كغ)"), "21");
    await fireEvent.changeText(screen.getByLabelText("الوزن الصافي (كغ) *"), "20");
    await fireEvent.changeText(screen.getByLabelText("السعر / كغ (USD) *"), "3");
    await fireEvent.changeText(screen.getByLabelText("الخصم (مبلغ)"), "5");
    expect(
      within(screen.getByTestId("screen-footer")).getByTestId("entry-line-total"),
    ).toBeTruthy();
    expect(screen.getByText("55.00 USD")).toBeTruthy();
    await fireEvent.press(screen.getByTestId("entry-line-save-next"));
    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        fabricName: "قطن",
        colorName: "أبيض",
        colorCode: "W-1",
        quantityKg: 20,
        pieces: 4,
        pricePerKg: 3,
        discountAmount: 5,
        details: expect.objectContaining({ kromaj: "180", grossKg: 21 }),
      }),
      true,
    );
  });
});
