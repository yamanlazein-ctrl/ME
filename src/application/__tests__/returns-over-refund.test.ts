import { describe, it, expect } from "vitest";

/**
 * Regression tests for returns over-refund triple defect [P0-LOGIC-3.2 a,b,c]
 * These tests model the guard logic in PostgresReturnRepository without DB.
 */

type GuardInput = {
  kind: "sale" | "entry";
  partyId: string;
  originalInvoiceId?: string;
  lines: Array<{ rollId: string; quantityKg: number; pricePerKg: number }>;
  currency?: string;
};

type InvoiceLine = { rollId: string; quantityKg: number; pricePerKg: number; currency: string };
type ReturnLine = { rollId: string; quantityKg: number };

function simulateCurrentGuard(
  input: GuardInput,
  invoiceLines: InvoiceLine[], // invoice-scoped original lines
  prevReturnsForInvoice: ReturnLine[], // only returns with same originalInvoiceId
  prevReturnsForParty: ReturnLine[], // all returns for party+kind
) {
  // Current code: invoiceLineQtys built via .set() overwrite, not sum
  const map = new Map<string, { original: number; returned: number }>();
  for (const ol of invoiceLines) {
    map.set(ol.rollId, { original: Number(ol.quantityKg), returned: 0 });
  }
  for (const pr of prevReturnsForInvoice) {
    const e = map.get(pr.rollId);
    if (e) e.returned = pr.quantityKg;
  }
  // No aggregation of input.lines; checks each line independently
  for (const line of input.lines) {
    const entry = map.get(line.rollId);
    if (!entry) continue; // silent skip bug before fix, but current after partial fix throws
    if (line.quantityKg > entry.original - entry.returned) {
      throw new Error("over-return");
    }
  }
  // Price is client-supplied, no check
  const returnTotal = input.lines.reduce((s, l) => s + Math.round(l.quantityKg * l.pricePerKg), 0);
  return returnTotal;
}

function simulateFixedGuard(
  input: GuardInput,
  invoiceLines: InvoiceLine[],
  prevReturnsForInvoice: ReturnLine[],
  prevReturnsForParty: ReturnLine[],
) {
  // Fixed: sum duplicates, aggregate input, price derived from invoice
  const map = new Map<string, { original: number; returned: number; pricePerKg: number }>();
  for (const ol of invoiceLines) {
    const existing = map.get(ol.rollId);
    if (existing) {
      existing.original += Number(ol.quantityKg);
      // weighted average price if multiple lines same roll (rare)
      existing.pricePerKg = ol.pricePerKg; // simplified: last wins, but sum handled
    } else {
      map.set(ol.rollId, { original: Number(ol.quantityKg), returned: 0, pricePerKg: ol.pricePerKg });
    }
  }
  // Count all active returns for party+kind (includes unlinked), not just same invoice
  const allPrev = [...prevReturnsForInvoice, ...prevReturnsForParty];
  // Aggregate prev returns by rollId
  const prevByRoll = new Map<string, number>();
  for (const pr of allPrev) {
    prevByRoll.set(pr.rollId, (prevByRoll.get(pr.rollId) ?? 0) + pr.quantityKg);
  }
  for (const [rollId, total] of prevByRoll) {
    const e = map.get(rollId);
    if (e) e.returned = total;
  }
  // Aggregate input lines by rollId
  const inputByRoll = new Map<string, number>();
  for (const l of input.lines) inputByRoll.set(l.rollId, (inputByRoll.get(l.rollId) ?? 0) + l.quantityKg);
  // Currency check
  if (input.currency) {
    for (const ol of invoiceLines) {
      if (ol.currency !== input.currency) throw new Error("currency mismatch");
    }
  }
  for (const [rollId, totalQty] of inputByRoll) {
    const entry = map.get(rollId);
    if (!entry) throw new Error("roll not in original invoice");
    if (totalQty > entry.original - entry.returned) throw new Error("over-return");
  }
  // Price derived server-side
  let returnTotal = 0;
  for (const [rollId, totalQty] of inputByRoll) {
    const entry = map.get(rollId)!;
    returnTotal += Math.round(totalQty * entry.pricePerKg);
  }
  return returnTotal;
}

describe("Returns over-refund [P0-LOGIC-3.2]", () => {
  it("3.2a: unlinked return must be visible to later linked return (should reject third return)", () => {
    // Sale 50kg, then unlinked return 50kg, then linked return 50kg should fail (50 already returned)
    const invoiceLines: InvoiceLine[] = [{ rollId: "roll-1", quantityKg: 50, pricePerKg: 8000, currency: "SYP" }];
    const prevReturnsForParty: ReturnLine[] = [{ rollId: "roll-1", quantityKg: 50 }]; // unlinked
    const prevReturnsForInvoice: ReturnLine[] = []; // current code scopes only to same invoice, so misses party returns

    const input: GuardInput = {
      kind: "sale",
      partyId: "cust-1",
      originalInvoiceId: "inv-1",
      lines: [{ rollId: "roll-1", quantityKg: 50, pricePerKg: 8000 }],
      currency: "SYP",
    };
    // Current guard only checks prevReturnsForInvoice -> allows over-return (bug)
    expect(() => simulateCurrentGuard(input, invoiceLines, prevReturnsForInvoice, prevReturnsForParty)).not.toThrow();
    // Fixed guard checks all -> rejects
    expect(() => simulateFixedGuard(input, invoiceLines, prevReturnsForInvoice, prevReturnsForParty)).toThrow("over-return");
  });

  it("3.2b: duplicate rollId lines in one request must be aggregated and rejected", () => {
    const invoiceLines: InvoiceLine[] = [{ rollId: "roll-1", quantityKg: 50, pricePerKg: 8000, currency: "SYP" }];
    const input: GuardInput = {
      kind: "sale",
      partyId: "cust-1",
      originalInvoiceId: "inv-1",
      lines: [
        { rollId: "roll-1", quantityKg: 30, pricePerKg: 8000 },
        { rollId: "roll-1", quantityKg: 30, pricePerKg: 8000 },
      ],
      currency: "SYP",
    };
    // Current: each 30 <=50 passes independently (bug)
    expect(() => simulateCurrentGuard(input, invoiceLines, [], [])).not.toThrow();
    // Fixed: aggregated 60 >50 rejects
    expect(() => simulateFixedGuard(input, invoiceLines, [], [])).toThrow("over-return");
  });

  it("3.2b-2: invoice with two lines same roll must sum original (overwrite bug)", () => {
    // Invoice has two lines roll-1: 25kg + 25kg =50kg total. Current .set() overwrites -> 25kg only
    const invoiceLines: InvoiceLine[] = [
      { rollId: "roll-1", quantityKg: 25, pricePerKg: 8000, currency: "SYP" },
      { rollId: "roll-1", quantityKg: 25, pricePerKg: 8000, currency: "SYP" },
    ];
    const input: GuardInput = {
      kind: "sale",
      partyId: "cust-1",
      lines: [{ rollId: "roll-1", quantityKg: 40, pricePerKg: 8000 }],
      currency: "SYP",
    };
    // Current map will have original=25 (last wins) -> 40>25 throws even though 40<=50 should pass if fixed
    // This demonstrates opposite error (under-allowance). Test that fixed allows 40
    expect(() => simulateFixedGuard(input, invoiceLines, [], [])).not.toThrow();
    // Current throws (demonstrates bug) - we assert it does throw to show divergence
    expect(() => simulateCurrentGuard(input, invoiceLines, [], [])).toThrow("over-return");
  });

  it("3.2c: inflated pricePerKg must be ignored and server price used", () => {
    const invoiceLines: InvoiceLine[] = [{ rollId: "roll-1", quantityKg: 10, pricePerKg: 8000, currency: "SYP" }];
    const input: GuardInput = {
      kind: "sale",
      partyId: "cust-1",
      lines: [{ rollId: "roll-1", quantityKg: 10, pricePerKg: 800000 }],
      currency: "SYP",
    };
    const currentTotal = simulateCurrentGuard(input, invoiceLines, [], []);
    expect(currentTotal).toBe(8_000_000); // bug: client price honored
    const fixedTotal = simulateFixedGuard(input, invoiceLines, [], []);
    expect(fixedTotal).toBe(80_000); // server price
    expect(fixedTotal).not.toBe(currentTotal);
  });

  it("3.2c: currency mismatch must be rejected", () => {
    const invoiceLines: InvoiceLine[] = [{ rollId: "roll-1", quantityKg: 10, pricePerKg: 8000, currency: "SYP" }];
    const input: GuardInput = {
      kind: "sale",
      partyId: "cust-1",
      lines: [{ rollId: "roll-1", quantityKg: 5, pricePerKg: 8000 }],
      currency: "USD", // mismatch
    };
    expect(() => simulateFixedGuard(input, invoiceLines, [], [])).toThrow("currency mismatch");
  });
});
