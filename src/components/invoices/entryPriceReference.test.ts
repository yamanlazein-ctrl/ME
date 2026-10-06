import { describe, it, expect } from "vitest";
import { entryPriceReference } from "./entryPriceReference";

const purchased = {
  entryPricePerKg: 4.75,
  entryCurrency: "USD" as const,
  entrySource: "purchase" as const,
  entryReference: "ENT-2026-0012",
  entryDate: "2026-02-02",
};

describe("entryPriceReference", () => {
  it("shows the exact roll's recorded entry price and where it came from", () => {
    const r = entryPriceReference(purchased, "USD", 6);
    expect(r).toMatchObject({
      pricePerKg: 4.75,
      currency: "USD",
      sourceLabel: "فاتورة شراء ENT-2026-0012",
      entryDate: "2026-02-02",
      belowEntry: false,
      otherCurrency: false,
    });
  });

  it("labels a printing-factory receive and a direct stock-in", () => {
    expect(entryPriceReference({ ...purchased, entrySource: "press", entryReference: "PJ-7" }, "USD", 0)?.sourceLabel).toBe(
      "استلام من المطبعة PJ-7",
    );
    expect(entryPriceReference({ ...purchased, entrySource: "stock_in", entryReference: null }, "USD", 0)?.sourceLabel).toBe(
      "إدخال مباشر للمخزون",
    );
  });

  it("flags a sale price below the entry price (same currency only)", () => {
    expect(entryPriceReference(purchased, "USD", 4.5)?.belowEntry).toBe(true);
    expect(entryPriceReference(purchased, "USD", 4.75)?.belowEntry).toBe(false);
    // no FX guess across currencies: shown in its own currency, never compared
    const syp = entryPriceReference(purchased, "SYP", 1);
    expect(syp).toMatchObject({ currency: "USD", otherCurrency: true, belowEntry: false });
  });

  it("shows nothing when no real entry price was recorded — never an estimate", () => {
    expect(entryPriceReference(undefined, "USD", 5)).toBeNull();
    expect(entryPriceReference({ ...purchased, entryPricePerKg: null }, "USD", 5)).toBeNull();
    expect(entryPriceReference({ ...purchased, entryPricePerKg: 0 }, "USD", 5)).toBeNull();
    expect(entryPriceReference({ ...purchased, entryCurrency: null }, "USD", 5)).toBeNull();
  });
});
