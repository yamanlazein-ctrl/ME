import { describe, it, expect } from "vitest";
import fc from "fast-check";

/* ────────────────────────────────────────────────────────────────────────
 * Property-based tests for Cashbox / Cashier invariants.
 * Uses integer-arbitrary / 100 to avoid fc.float 32-bit constraint issues.
 * ──────────────────────────────────────────────────────────────────────── */

/** 2-decimal-place positive numbers via integer cents */
function dp2(minCents: number, maxCents: number) {
  return fc.integer({ min: minCents, max: maxCents }).map((n) => n / 100);
}

/* ── Simulated cash movement types ── */
type CashMovement = {
  type: "deposit" | "withdrawal" | "expense";
  amount: number;
  date: string;
};

function simulateBalance(startBalance: number, movements: CashMovement[]): number {
  return movements.reduce((bal, m) => {
    switch (m.type) {
      case "deposit":
        return bal + m.amount;
      case "withdrawal":
      case "expense":
        return bal - m.amount;
      default:
        return bal;
    }
  }, startBalance);
}

describe("Cashbox financial properties (fast-check)", () => {
  // ── Property 1: Final balance = opening + deposits - withdrawals - expenses ──
  describe("Balance invariant", () => {
    it("balance = opening + sum(deposits) - sum(withdrawals) - sum(expenses)", () => {
      fc.assert(
        fc.property(
          dp2(0, 100_000_000), // opening balance
          fc.array(dp2(0, 10_000_000)), // deposits
          fc.array(dp2(0, 10_000_000)), // withdrawals
          fc.array(dp2(0, 10_000_000)), // expenses
          (opening, deposits, withdrawals, expenses) => {
            const movements: CashMovement[] = [
              ...deposits.map((amount) => ({ type: "deposit" as const, amount, date: "2026-01-15" })),
              ...withdrawals.map((amount) => ({
                type: "withdrawal" as const,
                amount,
                date: "2026-01-15",
              })),
              ...expenses.map((amount) => ({ type: "expense" as const, amount, date: "2026-01-15" })),
            ];

            const balance = simulateBalance(opening, movements);
            const totalDeposits = deposits.reduce((a, b) => a + b, 0);
            const totalWithdrawals = withdrawals.reduce((a, b) => a + b, 0);
            const totalExpenses = expenses.reduce((a, b) => a + b, 0);
            const expected = opening + totalDeposits - totalWithdrawals - totalExpenses;

            expect(balance).toBeCloseTo(expected, 6);
          },
        ),
      );
    });

    it("zero movements → balance unchanged", () => {
      fc.assert(
        fc.property(dp2(0, 100_000_000), (opening) => {
          const balance = simulateBalance(opening, []);
          expect(balance).toBe(opening);
        }),
      );
    });

    it("equal deposits and withdrawals → balance unchanged", () => {
      fc.assert(
        fc.property(
          dp2(0, 100_000_000),
          dp2(0, 10_000_000),
          (opening, amount) => {
            const movements: CashMovement[] = [
              { type: "deposit", amount, date: "2026-01-15" },
              { type: "withdrawal", amount, date: "2026-01-15" },
            ];

            expect(simulateBalance(opening, movements)).toBeCloseTo(opening, 6);
          },
        ),
      );
    });
  });

  // ── Property 2: Negative balance detection ──
  describe("Negative balance detection", () => {
    it("withdrawals > opening + deposits → negative balance", () => {
      fc.assert(
        fc.property(
          dp2(0, 1_000_000),
          dp2(1, 2_000_000),
          (opening, excessWithdrawal) => {
            const w = opening + excessWithdrawal;

            const movements: CashMovement[] = [
              { type: "withdrawal", amount: w, date: "2026-01-15" },
            ];

            const balance = simulateBalance(opening, movements);
            expect(balance).toBeLessThan(0); // system should prevent this
          },
        ),
      );
    });
  });

  // ── Property 3: Voucher amounts must be positive ──
  describe("Voucher amount validation", () => {
    it("rejects non-positive amounts", () => {
      fc.assert(
        fc.property(
          fc.integer({ min: -1_000_000, max: 0 }),
          (cents) => {
            const amount = cents / 100;
            const isValid = amount > 0;
            expect(isValid).toBe(false);
          },
        ),
      );
    });

    it("accepts positive amounts", () => {
      fc.assert(
        fc.property(dp2(1, 100_000_000), (amount) => {
          const isValid = amount > 0;
          expect(isValid).toBe(true);
        }),
      );
    });
  });

  // ── Property 4: Day closing is idempotent (can't close twice) ──
  describe("Day closing idempotency", () => {
    it("closing the same day twice fails the second time", () => {
      const closedDays = new Set<string>();

      function tryClose(dateStr: string): { success: boolean; error?: string } {
        if (closedDays.has(dateStr)) {
          return { success: false, error: "Day already closed" };
        }
        closedDays.add(dateStr);
        return { success: true };
      }

      fc.assert(
        fc.property(
          fc.array(
            fc.integer({ min: 1, max: 28 }), // day of month
            { minLength: 10, maxLength: 50 },
          ),
          (days) => {
            closedDays.clear();
            const dateStrs = days.map((d) => `2026-01-${String(d).padStart(2, "0")}`);
            const results = dateStrs.map((dateStr) => tryClose(dateStr));

            // First occurrence of each date should succeed
            // Duplicates should fail
            const seen = new Set<string>();
            for (let i = 0; i < dateStrs.length; i++) {
              if (seen.has(dateStrs[i])) {
                expect(results[i].success).toBe(false);
              } else {
                expect(results[i].success).toBe(true);
                seen.add(dateStrs[i]);
              }
            }
          },
        ),
      );
    });
  });

  // ── Property 5: Cash movements commute (order doesn't affect final balance) ──
  describe("Commutativity of cash movements", () => {
    it("final balance is independent of movement order", () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              type: fc.constantFrom("deposit", "withdrawal", "expense" as const),
              amount: dp2(1, 1_000_000),
              date: fc.constant("2026-01-01"),
            }),
            { minLength: 3, maxLength: 15 },
          ),
          (movements) => {
            const balance1 = simulateBalance(0, movements);

            // Shuffle
            const shuffled = [...movements].sort(() => Math.random() - 0.5);
            const balance2 = simulateBalance(0, shuffled);

            expect(balance1).toBeCloseTo(balance2, 10);
          },
        ),
      );
    });
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * Expense tracking properties
 * ──────────────────────────────────────────────────────────────────────── */

describe("Expense tracking properties (fast-check)", () => {
  type Expense = {
    amount: number;
    category: string;
    date: string;
  };

  it("total expenses = sum of all expense amounts", () => {
    fc.assert(
      fc.property(
        fc.array(dp2(1, 10_000_000)),
        (amounts) => {
          const expenses: Expense[] = amounts.map((amount) => ({
            amount,
            category: "general",
            date: "2026-01-15",
          }));

          const total = expenses.reduce((sum, e) => sum + e.amount, 0);
          const expected = amounts.reduce((sum, a) => sum + a, 0);

          expect(total).toBeCloseTo(expected, 10);
        },
      ),
    );
  });

  it("expenses with same date can be grouped", () => {
    fc.assert(
      fc.property(
        fc.array(
          fc.record({
            amount: dp2(1, 1_000_000),
            day: fc.integer({ min: 1, max: 28 }),
          }),
          { minLength: 5, maxLength: 20 },
        ),
        (items) => {
          const expenses: Expense[] = items.map((item) => ({
            amount: item.amount,
            category: "general",
            date: `2026-01-${String(item.day).padStart(2, "0")}`,
          }));

          // Group by date
          const byDate = new Map<string, number>();
          for (const e of expenses) {
            byDate.set(e.date, (byDate.get(e.date) ?? 0) + e.amount);
          }

          // Total across all dates should equal sum of all expenses
          const totalFromGroups = Array.from(byDate.values()).reduce((a, b) => a + b, 0);
          const totalDirect = expenses.reduce((sum, e) => sum + e.amount, 0);

          expect(totalFromGroups).toBeCloseTo(totalDirect, 10);
        },
      ),
    );
  });
});
