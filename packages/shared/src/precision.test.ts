import { describe, it, expect } from "vitest";
import { is2dp, is4dp, hasMoreThan2dp } from "./precision.js";

// CODEBASE_AUDIT_REPORT M-03: the fixed 1e-9 tolerance rejected valid large two-decimal amounts.
describe("is2dp / is4dp", () => {
  it("accepts large valid two-decimal amounts", () => {
    for (const v of [10000000.29, 99999999.99, 123456789.01, 0.1 + 0.2, 0.29, 1e12 + 0.07])
      expect(is2dp(v)).toBe(true);
    expect(hasMoreThan2dp(10000000.29)).toBe(false);
  });
  it("still rejects a third decimal at any magnitude", () => {
    for (const v of [0.001, 1.005, 10000000.295, 123456789.015]) expect(is2dp(v)).toBe(false);
    expect(hasMoreThan2dp(10000000.295)).toBe(true);
  });
  it("is4dp: same magnitude-aware check", () => {
    expect(is4dp(1000000.1234)).toBe(true);
    expect(is4dp(1000000.12345)).toBe(false);
  });
});

/**
 * F-008 — the single rounding policy: exact decimal, half away from zero (= PostgreSQL ROUND and the
 * SQLite engine). Ground truth below is BigInt arithmetic on the decimal inputs, never a float.
 */
import { round2dp, round4dp } from "./precision.js";

const dec = (s: string) => {
  const neg = s.startsWith("-");
  const [i, f = ""] = s.replace("-", "").split(".");
  return { v: BigInt(i + f) * (neg ? -1n : 1n), sc: f.length };
};
/** exact ROUND(a × b, k) half away from zero, as a JS number */
const exactMul = (a: string, b: string, k = 2) => {
  const x = dec(a),
    y = dec(b);
  const v = x.v * y.v,
    sc = x.sc + y.sc;
  if (sc <= k) return Number(v * 10n ** BigInt(k - sc)) / 10 ** k;
  const d = 10n ** BigInt(sc - k),
    m = v < 0n ? -v : v;
  let q = m / d;
  if ((m % d) * 2n >= d) q++;
  return Number(v < 0n ? -q : q) / 10 ** k;
};
const exactDiv = (a: string, b: string) => {
  const x = dec(a),
    y = dec(b);
  const num = x.v * 10n ** BigInt(y.sc + 2),
    den = y.v * 10n ** BigInt(x.sc);
  const m = num < 0n ? -num : num;
  let q = m / den;
  if ((m % den) * 2n >= den) q++;
  return Number(num < 0n ? -q : q) / 100;
};

describe("F-008 round2dp / round4dp — exact decimal, half away from zero", () => {
  it("half cents the float layer used to drop", () => {
    expect(round2dp(0.18 * 1.25)).toBe(0.23); // 0.22499999999999998 in binary
    expect(round2dp(0.7 * 0.05)).toBe(0.04);
    expect(round2dp(1.005)).toBe(1.01);
    expect(round2dp(2.675)).toBe(2.68);
    expect(round2dp(10.075)).toBe(10.08);
  });
  it("negatives round away from zero (Math.round(-2.5) is -2), never -0", () => {
    expect(round2dp(-0.225)).toBe(-0.23);
    expect(round2dp(-1.005)).toBe(-1.01);
    expect(round2dp(-0.0049)).toBe(0);
    expect(Object.is(round2dp(-0.001), -0)).toBe(false);
  });
  it("large SYP magnitudes (numeric(14,2): 12 integer digits)", () => {
    expect(round2dp(999_999_999_999.995)).toBe(1_000_000_000_000);
    expect(round2dp(39_538_000 * 1.5)).toBe(59_307_000);
    expect(round2dp(10_000_000.29)).toBe(10_000_000.29);
    expect(round2dp(123_456_789.005)).toBe(123_456_789.01);
  });
  it("non-finite → 0; already-rounded values unchanged", () => {
    expect(round2dp(NaN)).toBe(0);
    expect(round2dp(Infinity)).toBe(0);
    for (const v of [0, 0.01, 12.34, -12.34, 100, 2323.42]) expect(round2dp(v)).toBe(v);
  });
  it("round4dp: unit prices / costs", () => {
    expect(round4dp(0.00125)).toBe(0.0013);
    expect(round4dp(26.66665)).toBe(26.6667);
    expect(round4dp(80 / 3)).toBe(26.6667);
    expect(round4dp(-0.00005)).toBe(-0.0001);
  });

  it("matches exact decimal rounding on every case of the F-008 grid", () => {
    const off: string[] = [];
    const fmt = (x: number, dp: number) => x.toFixed(dp);
    // qty (2dp) × price (2dp and 4dp), positive and negative
    for (let q = 1; q <= 3000; q++) {
      const qs = fmt(q / 100, 2);
      for (const p of ["0.05", "0.15", "1.25", "2.35", "10.05", "12.55", "4.45"]) {
        for (const [a, b] of [
          [qs, p],
          ["-" + qs, p],
        ] as const) {
          if (round2dp(Number(a) * Number(b)) !== exactMul(a, b)) off.push(`${a}×${b}`);
        }
      }
      for (const p of ["26.6667", "8.3333", "12.3450", "0.0125", "7.1415"]) {
        if (round2dp(Number(qs) * Number(p)) !== exactMul(qs, p)) off.push(`${qs}×${p}`);
      }
    }
    // USD → SYP (× rate) and SYP → USD (÷ rate)
    for (let u = 1; u <= 20000; u += 7) {
      const us = fmt(u / 100, 2);
      for (const r of ["13500", "12700.5", "14650.25"]) {
        if (round2dp(Number(us) * Number(r)) !== exactMul(us, r)) off.push(`${us}×${r}`);
      }
    }
    for (let a = 1000; a <= 2_000_000; a += 997) {
      for (const r of ["13500", "12700", "14650", "10000"]) {
        if (round2dp(a / Number(r)) !== exactDiv(String(a), r)) off.push(`${a}÷${r}`);
      }
    }
    expect(off.slice(0, 10)).toEqual([]);
  });
});
