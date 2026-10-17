/**
 * Owner report 2026-10-13: the customer/supplier opening balance would not take "32,900.32" $
 * (commas, cents). Every amount/quantity field now goes through DecimalInput + decimalText.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { renderToString } from "react-dom/server";
import { DecimalInput } from "./DecimalInput";
import { groupThousands, isPartialDecimal, normalizeDecimalText } from "./decimalText";
import { parseAmount } from "@/presentation/hooks/useCurrency";
import { emptyDraft, openingAmountError, toPatch } from "@/components/parties/partyFormModel";

describe("decimal text", () => {
  it("reads what people type: thousands commas, cents, Arabic digits and signs", () => {
    expect(normalizeDecimalText("32,900.32")).toBe("32900.32");
    expect(normalizeDecimalText("٣٢٬٩٠٠٫٣٢")).toBe("32900.32");
    expect(normalizeDecimalText("۱۲۵ ۰۰۰")).toBe("125000");
    expect(parseAmount("٣٢٬٩٠٠٫٣٢")).toBe(32900.32);
    expect(parseAmount("32,900.32")).toBe(32900.32);
  });

  it("accepts a number while it is being typed, rejects letters and a second point", () => {
    for (const s of ["", "12", "12.", ".5", "32900.32"]) expect(isPartialDecimal(s)).toBe(true);
    for (const s of ["12a", "1.2.3", "-5"]) expect(isPartialDecimal(s)).toBe(false);
    expect(isPartialDecimal("-5", true)).toBe(true);
  });

  it("money and kg take at most two decimals (cents); per-kg prices and rates four", () => {
    expect(isPartialDecimal("32900.32")).toBe(true);
    expect(isPartialDecimal("32900.321")).toBe(false);
    expect(isPartialDecimal("12.5")).toBe(true);
    expect(isPartialDecimal("1.2345", false, 4)).toBe(true);
    expect(isPartialDecimal("1.23456", false, 4)).toBe(false);
    expect(isPartialDecimal("1,000,000.25".replace(/,/g, ""))).toBe(true);
  });

  it("groups thousands without rounding the decimals", () => {
    expect(groupThousands("32900.32")).toBe("32,900.32");
    expect(groupThousands("1234567.125")).toBe("1,234,567.125");
    expect(groupThousands("12.")).toBe("12.");
    // Typing "100.05" passes through "100.0": the zero must stay on screen (it used to vanish).
    expect(groupThousands(normalizeDecimalText("100.0"))).toBe("100.0");
    expect(groupThousands(normalizeDecimalText("1,000,000.0"))).toBe("1,000,000.0");
    expect(groupThousands("")).toBe("");
  });

  it("an opening balance of 32,900.32 $ reaches the API as 32900.32", () => {
    const d = {
      ...emptyDraft("customer"),
      name: "زبون",
      openingAmount: normalizeDecimalText("32,900.32"),
      openingCurrency: "USD" as const,
    };
    const patch = toPatch(d, "customer", undefined);
    expect(patch.openingBalance).toBe(32900.32);
  });

  it("save accepts every ordinary 2-decimal amount (3.0.1 rejected 32,900.13 on save)", () => {
    const err = (typed: string) =>
      openingAmountError({ ...emptyDraft("customer"), openingAmount: normalizeDecimalText(typed) });
    for (const t of [
      "32900.13",
      "32,900.13",
      "1,000,000.50",
      "100",
      "19.99",
      "0.29",
      "٣٢٬٩٠٠٫١٣",
      "",
    ])
      expect(err(t), t).toBeNull();
    // Every cent value from .00 to .99 on a large amount: none may be lost to float error.
    for (let c = 0; c < 100; c++) expect(err(`32900.${String(c).padStart(2, "0")}`)).toBeNull();
    expect(err("32900.135")).not.toBeNull();
  });

  it("renders a text box with a decimal keyboard and the grouped value", () => {
    const html = renderToString(<DecimalInput value="32900.32" onChange={() => {}} />);
    expect(html).toContain('type="text"');
    expect(html).toContain('inputMode="decimal"');
    expect(html).toContain('value="32,900.32"');
  });
});

describe("no amount or quantity field is a native number input", () => {
  // A native <input type="number"> rejects commas and Arabic digits. Only whole-number counters
  // (pieces, copies, year, invite minutes) may stay native.
  const allowed =
    /value=\{(year|p\.copies|ttlMinutes|pieces|l\.pieces[^}]*|line\.pieces|remaining)\}/;
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((n) => {
      const p = join(dir, n);
      return statSync(p).isDirectory()
        ? files(p)
        : p.endsWith(".tsx") && !p.includes(".test.") && !p.endsWith("DecimalInput.tsx")
          ? [p]
          : [];
    });

  it("holds across src/", () => {
    const offenders: string[] = [];
    for (const f of files(join(__dirname, "..", ".."))) {
      const s = readFileSync(f, "utf8");
      for (const m of s.matchAll(/<Input\b[^]*?\/>/g)) {
        if (m[0].includes('type="number"') && !allowed.test(m[0]))
          offenders.push(`${f}: ${m[0].slice(0, 80)}`);
      }
    }
    expect(offenders).toEqual([]);
  });
});
