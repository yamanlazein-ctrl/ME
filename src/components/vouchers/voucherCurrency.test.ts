import { describe, it, expect } from "vitest";
import { currencyForParty } from "./voucherCurrency";

describe("currencyForParty — voucher opens in the currency the party holds", () => {
  it("a USD-only opening opens in USD, so the badge shows the balance, not 'متوازن'", () => {
    const party = {
      currency: "SYP",
      stats: { byCurrency: { USD: { remaining: 100000 }, SYP: { remaining: 0 } } },
    };
    expect(currencyForParty(party)).toBe("USD");
  });

  it("a SYP opening stays in SYP", () => {
    const party = { currency: "SYP", stats: { byCurrency: { SYP: { remaining: 32900.13 } } } };
    expect(currencyForParty(party)).toBe("SYP");
  });

  it("a debt in several currencies opens in the largest, and a credit counts by magnitude", () => {
    const party = {
      currency: "SYP",
      stats: { byCurrency: { SYP: { remaining: 500 }, USD: { remaining: -40000 } } },
    };
    expect(currencyForParty(party)).toBe("USD");
  });

  it("ties resolve deterministically by currency code", () => {
    const party = {
      currency: "SYP",
      stats: { byCurrency: { USD: { remaining: 10 }, SYP: { remaining: -10 } } },
    };
    expect(currencyForParty(party)).toBe("SYP");
  });

  it("a party with no balance opens in its own default currency", () => {
    expect(currencyForParty({ currency: "USD", stats: { byCurrency: {} } })).toBe("USD");
  });

  it("a fully settled party (zero balances) also falls back to its default currency", () => {
    const party = { currency: "EUR", stats: { byCurrency: { USD: { remaining: 0 } } } };
    expect(currencyForParty(party)).toBe("EUR");
  });

  it("an unknown party keeps the form's current currency (fallback)", () => {
    expect(currencyForParty(undefined, "USD")).toBe("USD");
    expect(currencyForParty(undefined)).toBe("SYP");
  });

  it("sub-cent residue is treated as no balance", () => {
    const party = { currency: "SYP", stats: { byCurrency: { USD: { remaining: 0.001 } } } };
    expect(currencyForParty(party)).toBe("SYP");
  });
});
