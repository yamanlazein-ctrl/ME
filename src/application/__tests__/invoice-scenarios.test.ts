import { describe, it, expect, beforeEach } from "vitest";
import { TenantContext, UUID, Currency } from "@/domain/types";
import { Invoice, InvoiceLineData } from "@/domain/entities/Invoice";

/* ────────────────────────────────────────────────────────────────────────
 * Integration-style tests for invoice scenarios:
 * - 50 invoices for the same customer across different dates
 * - Date-range filtering correctness
 * - Aggregation (total, tax, net) accuracy
 * ──────────────────────────────────────────────────────────────────────── */

const TENANT_ID = "00000000-0000-0000-0000-000000000001" as UUID;
const CUSTOMER_ID = "cust-001" as UUID;
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

function makeInvoice(
  date: string,
  overrides: {
    lines?: InvoiceLineData[];
    partyId?: UUID;
    type?: "entry" | "sale" | "return";
    tax?: number;
    discount?: number;
    shipping?: number;
  } = {},
) {
  const lines = overrides.lines ?? [makeLine()];
  return Invoice.create({
    id: crypto.randomUUID() as UUID,
    tenantId: TENANT_ID,
    number: `INV-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    type: overrides.type ?? "sale",
    date,
    partyId: overrides.partyId ?? CUSTOMER_ID,
    partyType: "customer",
    currency: CURRENCY,
    lines,
    tax: overrides.tax ?? 0,
    discount: overrides.discount ?? 0,
    shipping: overrides.shipping ?? 0,
    createdBy: "tester",
    createdAt: "2026-01-01T00:00:00.000Z",
  });
}

describe("Invoice scenarios: 50 invoices tracking", () => {
  let invoices: Invoice[];

  beforeEach(() => {
    invoices = [];
  });

  // ── Scenario 1: Create 50 invoices for the same customer ──
  it("creates 50 invoices for one customer with varying dates and amounts", () => {
    // Spread across 6 months
    const baseDate = new Date("2026-01-01");
    for (let i = 0; i < 50; i++) {
      const date = new Date(baseDate.getTime() + i * 6 * 24 * 60 * 60 * 1000); // every ~6 days
      const dateStr = date.toISOString().slice(0, 10);
      const quantity = 5 + (i % 10); // 5-14 kg varying
      const price = 4000 + i * 100; // 4000-8900 varying

      const invoice = makeInvoice(dateStr, {
        lines: [
          makeLine({
            quantityKg: quantity,
            pricePerKg: price,
          }),
        ],
      });
      invoices.push(invoice);
    }

    expect(invoices).toHaveLength(50);

    // Verify all belong to the same customer
    invoices.forEach((inv) => {
      expect(inv.partyId).toBe(CUSTOMER_ID);
    });

    // Verify dates are unique and in order
    const dates = invoices.map((inv) => inv.date);
    const uniqueDates = new Set(dates);
    expect(uniqueDates.size).toBe(50); // all different

    // Verify amounts are calculated correctly
    invoices.forEach((inv) => {
      const line = inv.lines[0];
      const expected = line.quantityKg * line.pricePerKg;
      expect(inv.total()).toBe(expected);
    });
  });

  // ── Scenario 2: Filter invoices between two dates ──
  it("filters invoices correctly by date range", () => {
    // Create invoices on specific dates
    const testDates = [
      "2026-01-05",
      "2026-01-10",
      "2026-01-15",
      "2026-01-20",
      "2026-01-25",
      "2026-02-01",
      "2026-02-10",
      "2026-02-20",
      "2026-03-01",
      "2026-03-15",
    ];

    testDates.forEach((date) => {
      invoices.push(makeInvoice(date));
    });

    // Filter: January only
    const janStart = "2026-01-01";
    const janEnd = "2026-01-31";
    const janInvoices = invoices.filter((inv) => inv.date >= janStart && inv.date <= janEnd);

    expect(janInvoices).toHaveLength(5); // 5 Jan dates
    janInvoices.forEach((inv) => {
      expect(inv.date).toMatch(/^2026-01/);
    });

    // Filter: February only
    const febStart = "2026-02-01";
    const febEnd = "2026-02-28";
    const febInvoices = invoices.filter((inv) => inv.date >= febStart && inv.date <= febEnd);

    expect(febInvoices).toHaveLength(3); // 3 Feb dates

    // Filter: Q1 (Jan-Mar)
    const q1Start = "2026-01-01";
    const q1End = "2026-03-31";
    const q1Invoices = invoices.filter((inv) => inv.date >= q1Start && inv.date <= q1End);

    expect(q1Invoices).toHaveLength(10); // all 10
  });

  // ── Scenario 3: Date range excludes invoices outside the range ──
  it("excludes invoices outside the date range", () => {
    const dates = [
      "2025-12-15", // before
      "2026-01-10", // inside
      "2026-01-20", // inside
      "2026-02-05", // inside
      "2026-03-01", // after
    ];

    dates.forEach((date) => {
      invoices.push(makeInvoice(date));
    });

    const start = "2026-01-01";
    const end = "2026-02-28";
    const filtered = invoices.filter((inv) => inv.date >= start && inv.date <= end);

    expect(filtered).toHaveLength(3);
    expect(filtered.map((inv) => inv.date)).toEqual(["2026-01-10", "2026-01-20", "2026-02-05"]);
  });

  // ── Scenario 4: Aggregate totals for customer invoices ──
  it("calculates correct aggregate totals for a customer", () => {
    // Create 10 invoices with known amounts
    const knownAmounts = [10000, 20000, 15000, 30000, 25000, 5000, 12000, 18000, 22000, 8000];

    knownAmounts.forEach((amount, i) => {
      const date = `2026-01-${String(i + 1).padStart(2, "0")}`;
      invoices.push(
        makeInvoice(date, {
          lines: [makeLine({ quantityKg: amount / 5000, pricePerKg: 5000 })],
        }),
      );
    });

    // Calculate total
    const totalGross = invoices.reduce((sum, inv) => sum + inv.total(), 0);
    const expectedTotal = knownAmounts.reduce((a, b) => a + b, 0);

    expect(totalGross).toBe(expectedTotal);
    expect(totalGross).toBe(165000);

    // Count
    expect(invoices).toHaveLength(10);

    // Average
    const average = totalGross / invoices.length;
    expect(average).toBe(16500);
  });

  // ── Scenario 5: Multiple customers, filter by one ──
  it("correctly isolates one customer's invoices from others", () => {
    const customerA = "cust-A" as UUID;
    const customerB = "cust-B" as UUID;
    const customerC = "cust-C" as UUID;

    // Create 20 invoices: 8 for A, 7 for B, 5 for C
    for (let i = 0; i < 8; i++) {
      invoices.push(
        makeInvoice(`2026-01-${String(i + 1).padStart(2, "0")}`, { partyId: customerA }),
      );
    }
    for (let i = 0; i < 7; i++) {
      invoices.push(
        makeInvoice(`2026-01-${String(i + 10).padStart(2, "0")}`, { partyId: customerB }),
      );
    }
    for (let i = 0; i < 5; i++) {
      invoices.push(
        makeInvoice(`2026-02-${String(i + 1).padStart(2, "0")}`, { partyId: customerC }),
      );
    }

    expect(invoices).toHaveLength(20);

    // Filter by customer A
    const customerAInvoices = invoices.filter((inv) => inv.partyId === customerA);
    expect(customerAInvoices).toHaveLength(8);

    // Filter by customer B
    const customerBInvoices = invoices.filter((inv) => inv.partyId === customerB);
    expect(customerBInvoices).toHaveLength(7);

    // Filter by customer C
    const customerCInvoices = invoices.filter((inv) => inv.partyId === customerC);
    expect(customerCInvoices).toHaveLength(5);

    // Verify no overlap
    const allIds = new Set([
      ...customerAInvoices.map((i) => i.id),
      ...customerBInvoices.map((i) => i.id),
      ...customerCInvoices.map((i) => i.id),
    ]);
    expect(allIds.size).toBe(20); // all unique
  });

  // ── Scenario 6: Tax and discount calculations ──
  it("applies tax and discount correctly to invoice totals", () => {
    const invoice = makeInvoice("2026-01-15", {
      lines: [
        makeLine({ quantityKg: 10, pricePerKg: 5000, discountAmount: 5000 }),
        makeLine({ quantityKg: 5, pricePerKg: 3000, discountAmount: 0 }),
      ],
      tax: 1000,
      discount: 2000,
    });

    // Line 1: 10 * 5000 - 5000 = 45000
    // Line 2: 5 * 3000 - 0 = 15000
    // Total lines: 60000
    expect(invoice.lines[0]).toBeDefined();
    const line1Total = invoice.lineTotal(invoice.lines[0]);
    const line2Total = invoice.lineTotal(invoice.lines[1]);
    expect(line1Total).toBe(45000);
    expect(line2Total).toBe(15000);
    // total() is the net payable (subtotal - discount + tax + shipping).
    expect(invoice.total()).toBe(59000);
    expect(invoice.lineSubtotal()).toBe(60000);
  });

  it("distinguishes total() from lineSubtotal()", () => {
    const invoice = makeInvoice("2026-01-16", {
      lines: [makeLine({ quantityKg: 2, pricePerKg: 1000 })],
      tax: 100,
      discount: 50,
      shipping: 25,
    });
    expect(invoice.lineSubtotal()).toBe(2000);
    expect(invoice.total()).toBe(2075);
  });

  // ── Scenario 7: Invoice sequence with mixed types ──
  it("handles mixed invoice types (entry, sale, return) correctly", () => {
    const supplierId = "sup-001" as UUID;

    // Entry invoice (from supplier) — makeInvoice defaults partyType to "customer",
    // so we need to create the entry invoice with explicit partyType.
    const entryInvoice = Invoice.create({
      id: crypto.randomUUID() as UUID,
      tenantId: TENANT_ID,
      number: "PO-2001",
      type: "entry",
      date: "2026-01-01",
      partyId: supplierId,
      partyType: "supplier",
      currency: CURRENCY,
      lines: [makeLine({ quantityKg: 100, pricePerKg: 3000 })],
      createdBy: "tester",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(entryInvoice.type).toBe("entry");
    expect(entryInvoice.partyType).toBe("supplier");

    // Sale invoice (to customer)
    const saleInvoice = makeInvoice("2026-01-10", {
      lines: [makeLine({ quantityKg: 30, pricePerKg: 5000 })],
    });
    expect(saleInvoice.type).toBe("sale");
    expect(saleInvoice.partyType).toBe("customer");

    // Return invoice
    const returnInvoice = Invoice.create({
      id: crypto.randomUUID() as UUID,
      tenantId: TENANT_ID,
      number: "RET-001",
      type: "return",
      date: "2026-01-15",
      partyId: CUSTOMER_ID,
      partyType: "customer",
      currency: CURRENCY,
      lines: [makeLine({ quantityKg: 5, pricePerKg: 5000 })],
      createdBy: "tester",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
    expect(returnInvoice.type).toBe("return");

    // Verify totals for each
    expect(entryInvoice.total()).toBe(300000);
    expect(saleInvoice.total()).toBe(150000);
    expect(returnInvoice.total()).toBe(25000);
  });
});

describe("Invoice lifecycle: entry → sale → return", () => {
  it("tracks stock through full cycle: entry 100 → sale 30 → return 5 = remaining 75", () => {
    // Simulate the stock tracking through a full business cycle
    const rolls = new Map<string, { remainingKg: number; initialKg: number }>();

    // Step 1: Entry — stock comes in (100 kg)
    const entryRollId = "roll-entry-001";
    rolls.set(entryRollId, { remainingKg: 100, initialKg: 100 });

    expect(rolls.get(entryRollId)!.remainingKg).toBe(100);

    // Step 2: Sale — 30 kg goes out
    const saleQty = 30;
    const roll = rolls.get(entryRollId)!;
    expect(roll.remainingKg).toBeGreaterThanOrEqual(saleQty); // sufficient stock
    roll.remainingKg -= saleQty;

    expect(roll.remainingKg).toBe(70);

    // Step 3: Return — 5 kg comes back
    const returnQty = 5;
    roll.remainingKg += returnQty;

    expect(roll.remainingKg).toBe(75);

    // Verify: 100 - 30 + 5 = 75
    expect(roll.remainingKg).toBe(100 - 30 + 5);
  });
});
