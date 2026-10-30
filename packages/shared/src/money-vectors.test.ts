import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { invoiceTotal, lineTotal } from "./entities/Invoice.js";
import { runMoneyVector, type MoneyVector } from "./moneyVectorsRunner.js";

const vectors = JSON.parse(
  readFileSync(fileURLToPath(new URL("./money-vectors.json", import.meta.url)), "utf8"),
) as MoneyVector[];

type Line = { qty: string; price: string; discountAmount: string };
const toShared = (l: Line) =>
  ({
    quantityKg: Number(l.qty),
    pricePerKg: Number(l.price),
    discountAmount: Number(l.discountAmount),
  }) as never;

describe("money vectors (constitution IV)", () => {
  it("has at least 120 cases with unique ids", () => {
    expect(vectors.length).toBeGreaterThanOrEqual(120);
    expect(new Set(vectors.map((v) => v.id)).size).toBe(vectors.length);
  });

  it.each(vectors.map((v) => [v.id, v] as const))("%s", (_id, v) => {
    const got = runMoneyVector(v);
    expect(Object.is(got, -0)).toBe(false);
    expect(got).toBe(Number(v.expected));
  });

  it("agrees with the shared invoice helpers used by the backend", () => {
    for (const v of vectors) {
      if (v.op === "lineValue")
        expect(lineTotal(toShared(v.input as Line))).toBe(Number(v.expected));
      if (v.op === "invoiceTotal") {
        const i = v.input as { lines: Line[]; discount: string; tax: string; shipping: string };
        expect(
          invoiceTotal({
            lines: i.lines.map(toShared),
            discount: Number(i.discount),
            tax: Number(i.tax),
            shipping: Number(i.shipping),
          }),
        ).toBe(Number(v.expected));
      }
    }
  });
});
