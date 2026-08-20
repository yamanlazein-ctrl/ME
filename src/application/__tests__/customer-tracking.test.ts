import { describe, it, expect } from "vitest";
import fc from "fast-check";
import { TenantContext, UUID, Currency } from "@/domain/types";
import { Invoice, InvoiceLineData } from "@/domain/entities/Invoice";

/* ────────────────────────────────────────────────────────────────────────
 * Customer tracking tests: find invoices for a customer between dates.
 * Uses integer-based amounts to avoid fc.float 32-bit constraint issues.
 * ──────────────────────────────────────────────────────────────────────── */

const TENANT_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const CURRENCY: Currency = "SYP";

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

/** Filter invoices by customer and date range */
function filterInvoices(
  invoices: Invoice[],
  customerId: UUID,
  startDate: string,
  endDate: string,
): Invoice[] {
  return invoices.filter(
    (inv) => inv.partyId === customerId && inv.date >= startDate && inv.date <= endDate,
  );
}

/** 2-decimal-place positive numbers via integer cents */
function dp2(minCents: number, maxCents: number) {
  return fc.integer({ min: minCents, max: maxCents }).map((n) => n / 100);
}

describe("Customer tracking: date-range filtering (fast-check)", () => {
  // ── Property 1: Filter returns only invoices within range ──
  describe("Date range filtering invariants", () => {
    it("all returned invoices have date >= start and date <= end", () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              day: fc.integer({ min: 1, max: 28 }),
              amountCents: fc.integer({ min: 100, max: 5_000_000 }),
              customerId: fc.constantFrom("A", "B", "C" as const),
            }),
            { minLength: 10, maxLength: 50 },
          ),
          fc.integer({ min: 1, max: 20 }), // start day
          fc.integer({ min: 5, max: 28 }), // end day
          (items, startDay, endDay) => {
            if (startDay > endDay) return true; // skip invalid ranges

            const startDate = `2026-01-${String(startDay).padStart(2, "0")}`;
            const endDate = `2026-01-${String(endDay).padStart(2, "0")}`;

            const invoices: Invoice[] = items.map((item) => {
              const date = `2026-01-${String(item.day).padStart(2, "0")}`;
              const partyId =
                item.customerId === "A"
                  ? ("cust-A" as UUID)
                  : item.customerId === "B"
                    ? ("cust-B" as UUID)
                    : ("cust-C" as UUID);
              const amount = item.amountCents / 100;
              return Invoice.create({
                id: crypto.randomUUID() as UUID,
                tenantId: TENANT_ID,
                number: `INV-${item.customerId}-${item.day}`,
                type: "sale",
                date,
                partyId,
                partyType: "customer",
                currency: CURRENCY,
                lines: [
                  makeLine({
                    quantityKg: Math.max(0.01, Math.round((amount / 50) * 100) / 100),
                    pricePerKg: 5000,
                  }),
                ],
                createdBy: "tester",
                createdAt: "2026-01-01T00:00:00.000Z",
              });
            });

            const filtered = filterInvoices(invoices, "cust-A" as UUID, startDate, endDate);

            // Verify all returned invoices are within range
            for (const inv of filtered) {
              expect(inv.date >= startDate).toBe(true);
              expect(inv.date <= endDate).toBe(true);
              expect(inv.partyId).toBe("cust-A");
            }

            // Verify no invoices outside range are included
            const outsideRange = invoices.filter(
              (inv) => inv.partyId === "cust-A" && (inv.date < startDate || inv.date > endDate),
            );
            for (const inv of outsideRange) {
              expect(filtered.some((f) => f.id === inv.id)).toBe(false);
            }
          },
        ),
      );
    });

    // ── Property 2: Empty range returns nothing ──
    it("returns empty when start > end", () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              day: fc.integer({ min: 1, max: 28 }),
            }),
            { minLength: 1, maxLength: 20 },
          ),
          (items) => {
            const invoices: Invoice[] = items.map((item) => {
              const date = `2026-01-${String(item.day).padStart(2, "0")}`;
              return Invoice.create({
                id: crypto.randomUUID() as UUID,
                tenantId: TENANT_ID,
                number: `INV-${item.day}`,
                type: "sale",
                date,
                partyId: "cust-A" as UUID,
                partyType: "customer",
                currency: CURRENCY,
                lines: [makeLine()],
                createdBy: "tester",
                createdAt: "2026-01-01T00:00:00.000Z",
              });
            });

            // Invalid range: start after end
            const filtered = filterInvoices(invoices, "cust-A" as UUID, "2026-01-20", "2026-01-10");
            expect(filtered).toHaveLength(0);
          },
        ),
      );
    });

    // ── Property 3: Single-day range returns only that day ──
    it("single-day range returns only invoices on that day", () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              day: fc.integer({ min: 1, max: 28 }),
            }),
            { minLength: 5, maxLength: 20 },
          ),
          fc.integer({ min: 1, max: 28 }), // target day
          (items, targetDay) => {
            const targetDate = `2026-01-${String(targetDay).padStart(2, "0")}`;

            const invoices: Invoice[] = items.map((item) => {
              const date = `2026-01-${String(item.day).padStart(2, "0")}`;
              return Invoice.create({
                id: crypto.randomUUID() as UUID,
                tenantId: TENANT_ID,
                number: `INV-${item.day}`,
                type: "sale",
                date,
                partyId: "cust-A" as UUID,
                partyType: "customer",
                currency: CURRENCY,
                lines: [makeLine()],
                createdBy: "tester",
                createdAt: "2026-01-01T00:00:00.000Z",
              });
            });

            const filtered = filterInvoices(invoices, "cust-A" as UUID, targetDate, targetDate);

            for (const inv of filtered) {
              expect(inv.date).toBe(targetDate);
            }
          },
        ),
      );
    });
  });

  // ── Property 4: Aggregation correctness ──
  describe("Aggregation correctness", () => {
    it("sum of filtered invoices equals manual calculation", () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              day: fc.integer({ min: 1, max: 28 }),
              quantityCents: fc.integer({ min: 100, max: 5000 }), // 1.00 to 50.00 kg
              priceCents: fc.integer({ min: 100_000, max: 1_000_000 }), // 1000 to 10000
            }),
            { minLength: 10, maxLength: 30 },
          ),
          fc.integer({ min: 1, max: 15 }),
          fc.integer({ min: 15, max: 28 }),
          (items, startDay, endDay) => {
            if (startDay > endDay) return true;

            const startDate = `2026-01-${String(startDay).padStart(2, "0")}`;
            const endDate = `2026-01-${String(endDay).padStart(2, "0")}`;

            const invoices: Invoice[] = items.map((item, i) => {
              const date = `2026-01-${String(item.day).padStart(2, "0")}`;
              const q = item.quantityCents / 100;
              const p = item.priceCents / 100;
              return Invoice.create({
                id: crypto.randomUUID() as UUID,
                tenantId: TENANT_ID,
                number: `INV-${i}`,
                type: "sale",
                date,
                partyId: "cust-A" as UUID,
                partyType: "customer",
                currency: CURRENCY,
                lines: [makeLine({ quantityKg: q, pricePerKg: p })],
                createdBy: "tester",
                createdAt: "2026-01-01T00:00:00.000Z",
              });
            });

            const filtered = filterInvoices(invoices, "cust-A" as UUID, startDate, endDate);

            // Manual calculation
            let expectedTotal = 0;
            for (const item of items) {
              if (item.day >= startDay && item.day <= endDay) {
                const q = item.quantityCents / 100;
                const p = item.priceCents / 100;
                expectedTotal += q * p;
              }
            }

            const actualTotal = filtered.reduce((sum, inv) => sum + inv.total(), 0);
            expect(actualTotal).toBeCloseTo(expectedTotal, 5);
          },
        ),
      );
    });

    it("count of filtered invoices matches expected", () => {
      fc.assert(
        fc.property(
          fc.array(
            fc.record({
              day: fc.integer({ min: 1, max: 28 }),
              customerId: fc.constantFrom("A", "B", "C" as const),
            }),
            { minLength: 10, maxLength: 40 },
          ),
          fc.integer({ min: 1, max: 10 }),
          fc.integer({ min: 15, max: 28 }),
          (items, startDay, endDay) => {
            const startDate = `2026-01-${String(startDay).padStart(2, "0")}`;
            const endDate = `2026-01-${String(endDay).padStart(2, "0")}`;

            const invoices: Invoice[] = items.map((item, i) => {
              const date = `2026-01-${String(item.day).padStart(2, "0")}`;
              const partyId =
                item.customerId === "A"
                  ? ("cust-A" as UUID)
                  : item.customerId === "B"
                    ? ("cust-B" as UUID)
                    : ("cust-C" as UUID);
              return Invoice.create({
                id: crypto.randomUUID() as UUID,
                tenantId: TENANT_ID,
                number: `INV-${i}`,
                type: "sale",
                date,
                partyId,
                partyType: "customer",
                currency: CURRENCY,
                lines: [makeLine()],
                createdBy: "tester",
                createdAt: "2026-01-01T00:00:00.000Z",
              });
            });

            const filtered = filterInvoices(invoices, "cust-A" as UUID, startDate, endDate);

            // Manual count
            const expectedCount = items.filter(
              (item) => item.customerId === "A" && item.day >= startDay && item.day <= endDay,
            ).length;

            expect(filtered).toHaveLength(expectedCount);
          },
        ),
      );
    });
  });
});

/* ────────────────────────────────────────────────────────────────────────
 * Specific scenario tests (non-property-based)
 * ──────────────────────────────────────────────────────────────────────── */

describe("Customer tracking: specific scenarios", () => {
  const customerId = "cust-123" as UUID;

  function createInvoice(date: string, amount: number): Invoice {
    return Invoice.create({
      id: crypto.randomUUID() as UUID,
      tenantId: TENANT_ID,
      number: `INV-${date}-${Math.random()}`,
      type: "sale",
      date,
      partyId: customerId,
      partyType: "customer",
      currency: CURRENCY,
      lines: [makeLine({ quantityKg: amount / 5000, pricePerKg: 5000 })],
      createdBy: "tester",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  }

  it("finds 50 invoices for a customer across 6 months", () => {
    const invoices: Invoice[] = [];
    const baseDate = new Date("2026-01-01");

    for (let i = 0; i < 50; i++) {
      const date = new Date(baseDate.getTime() + i * 4 * 24 * 60 * 60 * 1000); // every 4 days
      const dateStr = date.toISOString().slice(0, 10);
      invoices.push(createInvoice(dateStr, 10000 + i * 500));
    }

    expect(invoices).toHaveLength(50);

    // All should belong to the customer
    invoices.forEach((inv) => {
      expect(inv.partyId).toBe(customerId);
    });
  });

  it("filters correctly: Jan 1 - Mar 31 returns Q1 invoices", () => {
    const invoices: Invoice[] = [
      createInvoice("2025-12-15", 5000), // before
      createInvoice("2026-01-05", 10000),
      createInvoice("2026-01-20", 15000),
      createInvoice("2026-02-10", 20000),
      createInvoice("2026-03-15", 25000),
      createInvoice("2026-04-01", 30000), // after
    ];

    const q1Invoices = filterInvoices(invoices, customerId, "2026-01-01", "2026-03-31");

    expect(q1Invoices).toHaveLength(4);
    expect(q1Invoices.map((i) => i.date)).toEqual([
      "2026-01-05",
      "2026-01-20",
      "2026-02-10",
      "2026-03-15",
    ]);

    const total = q1Invoices.reduce((sum, inv) => sum + inv.total(), 0);
    expect(total).toBeCloseTo(10000 + 15000 + 20000 + 25000, 5);
  });

  it("handles edge case: range with no matching invoices", () => {
    const invoices: Invoice[] = [
      createInvoice("2026-01-05", 10000),
      createInvoice("2026-03-15", 25000),
    ];

    const febInvoices = filterInvoices(invoices, customerId, "2026-02-01", "2026-02-28");

    expect(febInvoices).toHaveLength(0);
  });

  it("handles boundary dates correctly (inclusive)", () => {
    const invoices: Invoice[] = [
      createInvoice("2026-01-01", 5000), // exactly start
      createInvoice("2026-01-15", 10000),
      createInvoice("2026-01-31", 15000), // exactly end
    ];

    const janInvoices = filterInvoices(invoices, customerId, "2026-01-01", "2026-01-31");

    expect(janInvoices).toHaveLength(3);
    expect(janInvoices.map((i) => i.date)).toContain("2026-01-01");
    expect(janInvoices.map((i) => i.date)).toContain("2026-01-31");
  });

  it("filters by customer AND date simultaneously", () => {
    const customerA = "cust-A" as UUID;
    const customerB = "cust-B" as UUID;

    const invoices: Invoice[] = [
      Invoice.create({
        id: crypto.randomUUID() as UUID,
        tenantId: TENANT_ID,
        number: "INV-A1",
        type: "sale",
        date: "2026-01-10",
        partyId: customerA,
        partyType: "customer",
        currency: CURRENCY,
        lines: [makeLine({ quantityKg: 10, pricePerKg: 5000 })],
        createdBy: "tester",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
      Invoice.create({
        id: crypto.randomUUID() as UUID,
        tenantId: TENANT_ID,
        number: "INV-B1",
        type: "sale",
        date: "2026-01-10",
        partyId: customerB,
        partyType: "customer",
        currency: CURRENCY,
        lines: [makeLine({ quantityKg: 5, pricePerKg: 3000 })],
        createdBy: "tester",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
      Invoice.create({
        id: crypto.randomUUID() as UUID,
        tenantId: TENANT_ID,
        number: "INV-A2",
        type: "sale",
        date: "2026-02-10",
        partyId: customerA,
        partyType: "customer",
        currency: CURRENCY,
        lines: [makeLine({ quantityKg: 8, pricePerKg: 5000 })],
        createdBy: "tester",
        createdAt: "2026-01-01T00:00:00.000Z",
      }),
    ];

    // Customer A in January only
    const aJan = filterInvoices(invoices, customerA, "2026-01-01", "2026-01-31");
    expect(aJan).toHaveLength(1);
    expect(aJan[0].id).toBe(invoices[0].id);

    // Customer B in January
    const bJan = filterInvoices(invoices, customerB, "2026-01-01", "2026-01-31");
    expect(bJan).toHaveLength(1);
    expect(bJan[0].id).toBe(invoices[1].id);

    // All customers in Q1
    const allQ1 = invoices.filter((inv) => inv.date >= "2026-01-01" && inv.date <= "2026-03-31");
    expect(allQ1).toHaveLength(3);
  });
});
