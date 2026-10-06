/**
 * Bug #5 — the print-receive decimal fields.
 *
 * The operator-entered values named in the bug report (10.5, 19.75, 16.9) are
 * asserted here against the exact rule the three fields use
 * (`invoices.print-receive.new.tsx` → `acceptsDecimalKeystroke` /
 * `parseDecimalField`).
 *
 * The regression this guards is specific: a field that parses on every
 * keystroke with `Number()` collapses "10." to 10, so the operator can never
 * finish typing "10.5". Asserting the round-trip of the three values is what
 * distinguishes "accepts decimals" from "accepts decimals you can type".
 */
import { describe, it, expect } from "vitest";
import { acceptsDecimalKeystroke, parseDecimalField } from "../decimalInput";

describe("print-receive decimal fields (bug #5)", () => {
  describe("the exact values from the bug report", () => {
    it.each([
      ["الكمية المستلمة 10.5", "10.5", 10.5],
      ["تكلفة الطباعة 19.75", "19.75", 19.75],
      ["سعر البيع 16.9", "16.9", 16.9],
    ])("%s is accepted and parses exactly", (_label, raw, expected) => {
      expect(acceptsDecimalKeystroke(raw)).toBe(true);
      expect(parseDecimalField(raw)).toBe(expected);
    });
  });

  it("keeps a trailing separator so a decimal can actually be typed", () => {
    // "10." is incomplete: it must be ACCEPTED as text but must NOT parse to a
    // number, otherwise the next keystroke ("5") can never be appended.
    expect(acceptsDecimalKeystroke("10.")).toBe(true);
    expect(parseDecimalField("10.")).toBeNull();
    // …and once finished, it parses.
    expect(parseDecimalField("10.5")).toBe(10.5);
  });

  it("accepts a leading separator", () => {
    expect(acceptsDecimalKeystroke(".5")).toBe(true);
    expect(parseDecimalField(".5")).toBe(0.5);
  });

  it("accepts whole numbers and an empty field", () => {
    expect(parseDecimalField("10")).toBe(10);
    expect(acceptsDecimalKeystroke("")).toBe(true);
    expect(parseDecimalField("")).toBeNull();
    expect(parseDecimalField(".")).toBeNull();
  });

  it("rejects input that is not a plain non-negative decimal", () => {
    for (const bad of ["-5", "1.2.3", "1e5", " 10", "10 ", "abc", "10,5", "١٠"]) {
      expect(acceptsDecimalKeystroke(bad), bad).toBe(false);
      expect(parseDecimalField(bad), bad).toBeNull();
    }
  });

  it("preserves precision that a float round-trip would lose", () => {
    // The values must survive as the number the system will store and use.
    expect(parseDecimalField("19.75")).toBe(19.75);
    expect(parseDecimalField("0.1")! + parseDecimalField("0.2")!).toBeCloseTo(0.3, 10);
  });
});
