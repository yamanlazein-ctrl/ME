import { round2dp, round4dp } from "./precision.js";

/** One cross-runtime money case (constitution IV). Numbers are written as decimal strings. */
export type MoneyVector = {
  id: string;
  op: "round2dp" | "round4dp" | "lineValue" | "invoiceTotal" | "usdToSyp" | "sypToUsd";
  input: Record<string, unknown>;
  expected: number | string;
};

type VectorLine = { qty: string; price: string; discountAmount: string };

const lineValue = (l: VectorLine): number =>
  Math.max(0, round2dp(Number(l.qty) * Number(l.price) - Number(l.discountAmount)));

/** Runs a vector through the real rounding functions. Pure JavaScript: identical on Node and Hermes. */
export function runMoneyVector(v: MoneyVector): number {
  const input = v.input;
  switch (v.op) {
    case "round2dp":
      return round2dp(Number(input.value));
    case "round4dp":
      return round4dp(Number(input.value));
    case "lineValue":
      return lineValue(input as unknown as VectorLine);
    case "invoiceTotal": {
      const lines = input.lines as VectorLine[];
      const subtotal = round2dp(lines.reduce((s, l) => s + lineValue(l), 0));
      return round2dp(
        subtotal - Number(input.discount) + Number(input.tax) + Number(input.shipping),
      );
    }
    case "usdToSyp":
      return round2dp(Number(input.amount) * Number(input.rate));
    case "sypToUsd":
      return round2dp(Number(input.amount) / Number(input.rate));
  }
}

/** True when the vector passes; a negative zero result always fails. */
export function moneyVectorPasses(v: MoneyVector): boolean {
  const got = runMoneyVector(v);
  return Object.is(got, Number(v.expected));
}
