import { describe, expect, it } from "vitest";
import vectors from "../../../packages/shared/src/money-vectors.json";
import {
  draftProblems,
  draftTotals,
  emptyDraft,
  toCreateInput,
  type DraftLine,
  type SaleDraft,
} from "../../src/core/saleDraft";

type Vector = {
  id: string;
  op: string;
  input: {
    lines: Array<{ qty: string; price: string; discountAmount: string }>;
    discount: string;
    tax: string;
    shipping: string;
  };
  expected: number;
};

const line = (over: Partial<DraftLine> = {}): DraftLine => ({
  key: "k",
  fabricId: "f",
  fabricName: "قماش",
  colorId: "c",
  colorName: "أبيض",
  rollId: "r",
  rollNo: "R-1",
  remainingKg: 1000,
  quantityKg: 10,
  pieces: 0,
  pricePerKg: 5,
  discountAmount: 0,
  ...over,
});

describe("sale draft totals (FR-15)", () => {
  const cases = (vectors as Vector[]).filter((v) => v.op === "invoiceTotal").slice(0, 10);

  it("has 10 invoiceTotal vectors to run", () => {
    expect(cases).toHaveLength(10);
  });

  it.each(cases.map((v) => [v.id, v] as const))(
    "%s: the draft's displayed total equals the vector",
    (_id, v) => {
      const draft: SaleDraft = {
        ...emptyDraft(),
        lines: v.input.lines.map((l, i) =>
          line({
            key: `k${i}`,
            quantityKg: Number(l.qty),
            pricePerKg: Number(l.price),
            discountAmount: Number(l.discountAmount),
            remainingKg: 10 ** 9,
          }),
        ),
        discount: Number(v.input.discount),
        tax: Number(v.input.tax),
        shipping: Number(v.input.shipping),
      };
      expect(Object.is(draftTotals(draft).total, Number(v.expected))).toBe(true);
    },
  );

  it("payment reduces the amount due, never below zero", () => {
    const draft = { ...emptyDraft(), lines: [line()], paid: 20 };
    expect(draftTotals(draft)).toEqual({ subtotal: 50, total: 50, due: 30 });
    expect(draftTotals({ ...draft, paid: 500 }).due).toBe(0);
  });

  it("reports what is missing and refuses more kg than the roll holds", () => {
    expect(draftProblems(emptyDraft())).toEqual(["no-party", "no-rate", "no-lines"]);
    const ready: SaleDraft = {
      ...emptyDraft(),
      party: { id: "p", name: "عميل" },
      exchangeRate: 1,
      lines: [line({ quantityKg: 2000 })],
    };
    expect(draftProblems(ready)).toEqual(["over-stock"]);
    expect(draftProblems({ ...ready, lines: [line()] })).toEqual([]);
  });

  it("maps a complete draft to the use-case input", () => {
    const input = toCreateInput(
      {
        ...emptyDraft(),
        party: { id: "p", name: "ع" },
        exchangeRate: 14500,
        currency: "SYP",
        lines: [line()],
        paid: 5,
      },
      "2026-03-01",
    );
    expect(input).toMatchObject({
      type: "sale",
      partyId: "p",
      currency: "SYP",
      exchangeRate: 14500,
      paid: 5,
    });
    expect(input.lines).toHaveLength(1);
    expect(() => toCreateInput(emptyDraft(), "2026-03-01")).toThrow();
  });
});
