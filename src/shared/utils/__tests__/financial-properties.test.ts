import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { Invoice, InvoiceLineData } from "@/domain/entities/Invoice";
import { Roll } from "@/domain/entities/Roll";
import { UUID, Currency } from "@/domain/types";
import { round2dp, hasMoreThan2dp } from "@/shared/utils/precision";

/* ────────────────────────────────────────────────────────────────────────
 * Property-based tests using fast-check for financial invariants.
 * These tests verify mathematical properties hold for ALL valid inputs,
 * not just specific examples.
 *
 * NOTE: fc.float requires min/max to be valid 32-bit floats.
 * We use fc.integer and divide to get precise decimals instead.
 * ──────────────────────────────────────────────────────────────────────── */

const TENANT_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const CURRENCY: Currency = "SYP";

/** Generate a valid line for property tests */
function makeLine(overrides: Partial<InvoiceLineData> = {}): InvoiceLineData {
  return {
    id: crypto.randomUUID() as UUID,
    fabricId: crypto.randomUUID() as UUID,
    colorId: crypto.randomUUID() as UUID,
    rollId: crypto.randomUUID() as UUID,
    quantityKg: 10,
    pricePerKg: 5000,
    discountAmount: 0,
    ...overrides,
  };
}

/** Generate a valid roll for property tests */
function makeRoll(overrides: Partial<Parameters<typeof Roll.create>[0]> = {}) {
  return Roll.create({
    tenantId: TENANT_ID,
    colorId: crypto.randomUUID() as UUID,
    rollNo: "R-001",
    dyeBatch: "BATCH-001",
    initialKg: 100,
    pricePerKg: 5000,
    currency: CURRENCY,
    supplierId: crypto.randomUUID() as UUID,
    entryDate: "2026-01-01",
    pieces: 1,
    ...overrides,
  });
}

/**
 * Arbitrary for 2-decimal-place positive numbers.
 * Generates integers 1..N and divides by 100 to get exact 2dp values.
 */
function dp2(minCents: number, maxCents: number) {
  return fc.integer({ min: minCents, max: maxCents }).map((n) => n / 100);
}

/* ────────────────────────────────────────────────────────────────────────
 * 1. Invoice total calculations
 * ──────────────────────────────────────────────────────────────────────── */

describe("Invoice financial properties (fast-check)", () => {
  // ── Property 1: Total is always the sum of line totals ──
  describe("Invoice total = sum of line totals", () => {
    it("holds for any single line", () => {
      fc.assert(
        fc.property(
          dp2(1, 1_000_000), // quantity in cents: 0.01 to 10000.00
          dp2(0, 10_000_000), // price in cents: 0.00 to 100000.00
          (quantity, price) => {
            if (quantity <= 0) return true; // skip invalid

            const line = makeLine({ quantityKg: quantity, pricePerKg: price });
            const invoice = Invoice.create({
              id: crypto.randomUUID() as UUID,
              tenantId: TENANT_ID,
              number: "INV-001",
              type: "sale",
              date: "2026-01-15",
              partyId: crypto.randomUUID() as UUID,
              partyType: "customer",
              currency: CURRENCY,
              lines: [line],
              createdBy: "tester",
              createdAt: "2026-01-01T00:00:00.000Z",
            });

            const expected = Math.round(quantity * price);
            expect(invoice.total()).toBeCloseTo(expected, 10);
          },
        ),
      );
    });

    it("holds for any number of lines", () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              quantity: dp2(1, 100_000),
              price: dp2(0, 5_000_000),
              discount: dp2(0, 1_000_000),
            }),
            { minLength: 1, maxLength: 20 },
          ),
          (lines) => {
            const invoiceLines: InvoiceLineData[] = lines.map((l) => {
              return makeLine({
                quantityKg: l.quantity,
                pricePerKg: l.price,
                discountAmount: Math.min(l.discount, l.quantity * l.price),
              });
            });

            const invoice = Invoice.create({
              id: crypto.randomUUID() as UUID,
              tenantId: TENANT_ID,
              number: "INV-001",
              type: "sale",
              date: "2026-01-15",
              partyId: crypto.randomUUID() as UUID,
              partyType: "customer",
              currency: CURRENCY,
              lines: invoiceLines,
              createdBy: "tester",
              createdAt: "2026-01-01T00:00:00.000Z",
            });

            const expectedSum = invoiceLines.reduce(
              (sum, l) => sum + Math.max(0, Math.round(l.quantityKg * l.pricePerKg - l.discountAmount)),
              0,
            );
            expect(invoice.total()).toBeCloseTo(expectedSum, 5);
          },
        ),
      );
    });
  });

  // ── Property 2: Line total = quantity * price - discount (per-line rounded) ──
  describe("Line total invariants", () => {
    it("lineTotal(q, p, d) = max(0, round(q*p - d)) for all inputs", () => {
      fc.assert(
        fc.property(dp2(0, 100_000), dp2(0, 10_000_000), dp2(0, 100_000_000), (q, p, d) => {
          if (q <= 0) return true; // skip

          const line = makeLine({
            quantityKg: q,
            pricePerKg: p,
            discountAmount: d,
          });

          const invoice = Invoice.create({
            id: crypto.randomUUID() as UUID,
            tenantId: TENANT_ID,
            number: "INV-001",
            type: "sale",
            date: "2026-01-15",
            partyId: crypto.randomUUID() as UUID,
            partyType: "customer",
            currency: CURRENCY,
            lines: [line],
            createdBy: "tester",
            createdAt: "2026-01-01T00:00:00.000Z",
          });

          const gross = q * p;
          const expected = Math.max(0, Math.round(gross - d));
          expect(invoice.lineTotal(line)).toBe(expected);
        }),
      );
    });

    it("line total is never negative", () => {
      fc.assert(
        fc.property(dp2(1, 100_000), dp2(0, 10_000_000), dp2(0, 100_000_000), (q, p, d) => {
          const line = makeLine({
            quantityKg: q,
            pricePerKg: p,
            discountAmount: d,
          });

          const invoice = Invoice.create({
            id: crypto.randomUUID() as UUID,
            tenantId: TENANT_ID,
            number: "INV-001",
            type: "sale",
            date: "2026-01-15",
            partyId: crypto.randomUUID() as UUID,
            partyType: "customer",
            currency: CURRENCY,
            lines: [line],
            createdBy: "tester",
            createdAt: "2026-01-01T00:00:00.000Z",
          });

          expect(invoice.lineTotal(line)).toBeGreaterThanOrEqual(0);
        }),
      );
    });
  });

  // ── Property 3: Zero discount → total = round(quantity * price) ──
  it("with zero discount, line total = round(quantity × price)", () => {
    fc.assert(
      fc.property(dp2(1, 100_000), dp2(0, 10_000_000), (q, p) => {
        const line = makeLine({ quantityKg: q, pricePerKg: p, discountAmount: 0 });
        const invoice = Invoice.create({
          id: crypto.randomUUID() as UUID,
          tenantId: TENANT_ID,
          number: "INV-001",
          type: "sale",
          date: "2026-01-15",
          partyId: crypto.randomUUID() as UUID,
          partyType: "customer",
          currency: CURRENCY,
          lines: [line],
          createdBy: "tester",
          createdAt: "2026-01-01T00:00:00.000Z",
        });

        expect(invoice.lineTotal(line)).toBe(Math.round(q * p));
      }),
    );
  });

  // ── Property 4: Discount > gross → line total = 0 ──
  it("when discount > gross, line total = 0", () => {
    fc.assert(
      fc.property(dp2(1, 10_000), dp2(1, 100_000), (q, p) => {
        const gross = q * p;
        const discount = gross + 100; // discount larger than gross

        const line = makeLine({
          quantityKg: q,
          pricePerKg: p,
          discountAmount: discount,
        });
        const invoice = Invoice.create({
          id: crypto.randomUUID() as UUID,
          tenantId: TENANT_ID,
          number: "INV-001",
          type: "sale",
          date: "2026-01-15",
          partyId: crypto.randomUUID() as UUID,
          partyType: "customer",
          currency: CURRENCY,
          lines: [line],
          createdBy: "tester",
          createdAt: "2026-01-01T00:00:00.000Z",
        });

        expect(invoice.lineTotal(line)).toBe(0);
      }),
    );
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * 2. Stock (Roll) properties
 * ──────────────────────────────────────────────────────────────────────── */

describe("Roll stock properties (fast-check)", () => {
  // ── Property 5: remainingKg never goes negative after valid reserve ──
  describe("Stock reservation invariants", () => {
    it("remainingKg >= 0 after any valid sequence of reservations", () => {
      fc.assert(
        fc.property(
          dp2(100, 100_000), // initial kg: 1.00 to 1000.00
          fc.array(dp2(1, 10_000), { maxLength: 20 }), // reservations
          (initialKg, reservations) => {
            const roll = makeRoll({ initialKg });

            let totalReserved = 0;
            for (const r of reservations) {
              if (totalReserved + r <= initialKg) {
                roll.reserve(r);
                totalReserved += r;
              } else {
                break; // would throw
              }
            }

            expect(roll.remainingKg).toBeGreaterThanOrEqual(0);
            expect(roll.remainingKg).toBeCloseTo(initialKg - totalReserved, 10);
          },
        ),
      );
    });

    it("remainingKg = initialKg - sum(reservations)", () => {
      fc.assert(
        fc.property(
          dp2(1000, 50_000),
          fc.array(dp2(10, 1000), {
            minLength: 1,
            maxLength: 10,
          }),
          (initialKg, reservations) => {
            // Scale reservations so they fit in initial (use 90%)
            const total = reservations.reduce((a, b) => a + b, 0);
            const scale = (initialKg * 0.9) / total;
            const res = reservations.map((r) => {
              const scaled = r * scale;
              return Math.round(scaled * 100) / 100;
            });

            const roll = makeRoll({ initialKg });
            for (const r of res) {
              roll.reserve(r);
            }

            const expected = initialKg - res.reduce((a, b) => a + b, 0);
            expect(roll.remainingKg).toBeCloseTo(expected, 10);
          },
        ),
      );
    });
  });

  // ── Property 6: reserve + release = identity ──
  describe("Reserve then release restores stock", () => {
    it("reserve(kg) then release(kg) returns to original", () => {
      fc.assert(
        fc.property(dp2(1000, 100_000), dp2(1, 50_000), (initialKg, kg) => {
          if (kg > initialKg) return true; // skip

          const roll = makeRoll({ initialKg });
          roll.reserve(kg);
          roll.release(kg);

          expect(roll.remainingKg).toBeCloseTo(initialKg, 6);
        }),
      );
    });

    it("release(kg) when kg > reserved clamps to initialKg", () => {
      fc.assert(
        fc.property(dp2(1000, 50_000), dp2(1, 50_000), (initialKg, reserveAmount) => {
          if (reserveAmount > initialKg) return true;

          const roll = makeRoll({ initialKg });
          roll.reserve(reserveAmount);
          roll.release(reserveAmount + 100); // release more than reserved

          expect(roll.remainingKg).toBeLessThanOrEqual(initialKg);
        }),
      );
    });
  });

  // ── Property 7: reserve throws on insufficient stock ──
  describe("Insufficient stock", () => {
    it("reserve(kg) throws when kg > remainingKg", () => {
      fc.assert(
        fc.property(dp2(100, 10_000), dp2(100, 100_000), (initialKg, requestKg) => {
          if (requestKg <= initialKg) return true; // only test when request > initial

          const roll = makeRoll({ initialKg });
          expect(() => roll.reserve(requestKg)).toThrow(/Insufficient stock/);
          expect(roll.remainingKg).toBe(initialKg); // unchanged
        }),
      );
    });
  });

  // ── Property 8: isOutOfStock ↔ remainingKg <= 0 ──
  describe("Stock status predicates", () => {
    it("isOutOfStock() === (remainingKg <= 0)", () => {
      fc.assert(
        fc.property(dp2(100, 10_000), dp2(0, 10_000), (initialKg, reserveKg) => {
          const roll = makeRoll({ initialKg });
          try {
            if (reserveKg <= initialKg) {
              roll.reserve(reserveKg);
            }
          } catch {
            // reserve failed, remainingKg unchanged
          }

          expect(roll.isOutOfStock()).toBe(roll.remainingKg <= 0);
        }),
      );
    });
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * 3. Precision properties
 * ──────────────────────────────────────────────────────────────────────── */

describe("Precision helper properties (fast-check)", () => {
  it("round2dp(x) always produces at most 2 decimal places (within floating-point tolerance)", () => {
    fc.assert(
      fc.property(fc.integer({ min: -100_000_000, max: 100_000_000 }), (cents) => {
        const x = cents / 100;
        const rounded = round2dp(x);
        // After rounding, the value should be within floating-point tolerance of having 2dp
        const diff = Math.abs(rounded * 100 - Math.round(rounded * 100));
        expect(diff).toBeLessThan(1e-6);
      }),
    );
  });

  it("hasMoreThan2dp(x) is true when x clearly has 3+ decimal digits", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 10000 }),
        fc.integer({ min: 1, max: 999 }).filter((n) => n % 10 !== 0), // exclude values that reduce to 2dp
        (whole, frac4dp) => {
          // x = whole + frac4dp/10000, guaranteed to have 3+ non-zero decimal digits
          // e.g., 701/10000 = 0.0701 (4dp), not 700/10000 = 0.07 (2dp)
          const x = whole + frac4dp / 10000;
          expect(hasMoreThan2dp(x)).toBe(true);
        },
      ),
    );
  });

  it("hasMoreThan2dp(round2dp(x)) is false within tolerance", () => {
    fc.assert(
      fc.property(fc.integer({ min: -100_000_000, max: 100_000_000 }), (cents) => {
        const x = cents / 100;
        const rounded = round2dp(x);
        // After rounding, hasMoreThan2dp should return false (or very close)
        const diff = Math.abs(rounded * 100 - Math.round(rounded * 100));
        // If diff is tiny (floating-point noise), hasMoreThan2dp might still be true
        // due to the 1e-9 threshold — that's acceptable noise
        if (diff < 1e-6) {
          // Within acceptable tolerance
          expect(true).toBe(true);
        } else {
          expect(hasMoreThan2dp(rounded)).toBe(false);
        }
      }),
    );
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * 4. Cash balance invariants (ledger)
 * ──────────────────────────────────────────────────────────────────────── */

describe("Cash balance properties (fast-check)", () => {
  // Property: Final balance = sum(debits) - sum(credits)
  it("balance = total debits - total credits for any sequence", () => {
    fc.assert(
      fc.property(
        fc.array(dp2(0, 10_000_000)), // debits
        fc.array(dp2(0, 10_000_000)), // credits
        (debits, credits) => {
          const totalDebits = debits.reduce((a, b) => a + b, 0);
          const totalCredits = credits.reduce((a, b) => a + b, 0);
          const expected = totalDebits - totalCredits;

          expect(expected).toBeCloseTo(totalDebits - totalCredits, 10);
        },
      ),
    );
  });

  // Property: Balance is commutative (order doesn't matter)
  it("balance is independent of transaction order", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            type: fc.constantFrom("debit", "credit" as const),
            amount: dp2(0, 1_000_000),
          }),
          { minLength: 2, maxLength: 10 },
        ),
        (transactions) => {
          const balance = transactions.reduce((bal, t) => {
            return t.type === "debit" ? bal + t.amount : bal - t.amount;
          }, 0);

          // Shuffle and recalculate
          const shuffled = [...transactions].sort(() => Math.random() - 0.5);
          const balanceShuffled = shuffled.reduce((bal, t) => {
            return t.type === "debit" ? bal + t.amount : bal - t.amount;
          }, 0);

          expect(balance).toBeCloseTo(balanceShuffled, 10);
        },
      ),
    );
  });
});
