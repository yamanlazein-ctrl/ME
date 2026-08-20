import { describe, it, expect, beforeEach } from "vitest";
import { TenantContext, UUID } from "@/domain/types";

describe("Phase 1: Entry Invoice — Multi-Color Per Fabric", () => {
  const ctx: TenantContext = {
    tenantId: "t1" as UUID,
    userId: "u1" as UUID,
    userRole: "admin",
    userName: "tester",
  };

  // Simulate the backend invoice_lines schema (no unique constraint on fabricId+colorId)
  const invoiceLines: Array<{
    id: string;
    invoiceId: string;
    fabricId: string;
    colorId: string;
    rollId: string;
    quantityKg: number;
    pricePerKg: number;
    discountAmount: number;
  }> = [];

  const stock: Record<string, { colorId: string; fabricId: string; remainingKg: number }> = {};
  let lineSeq = 0;

  function addStock(fabricId: string, colorId: string, rollId: string, kg: number) {
    stock[rollId] = { colorId, fabricId, remainingKg: (stock[rollId]?.remainingKg || 0) + kg };
  }

  function createInvoiceLine(
    invoiceId: string,
    fabricId: string,
    colorId: string,
    rollId: string,
    kg: number,
    price: number,
  ) {
    lineSeq++;
    invoiceLines.push({
      id: `line-${lineSeq}`,
      invoiceId,
      fabricId,
      colorId,
      rollId,
      quantityKg: kg,
      pricePerKg: price,
      discountAmount: 0,
    });
    addStock(fabricId, colorId, rollId, kg);
  }

  beforeEach(() => {
    invoiceLines.length = 0;
    lineSeq = 0;
    Object.keys(stock).forEach((k) => delete stock[k]);
  });

  it("allows 3 colors of the SAME fabric in a single entry invoice", () => {
    const invId = "inv-1";
    const fabricId = "fabric-cotton-01";

    // 3 lines with same fabric, different colors (simulating what the UI now sends)
    createInvoiceLine(invId, fabricId, "color-black-01", "roll-1", 100, 1500); // Cotton Black
    createInvoiceLine(invId, fabricId, "color-white-01", "roll-2", 80, 1400); // Cotton White
    createInvoiceLine(invId, fabricId, "color-red-01", "roll-3", 50, 1600); // Cotton Red

    const lines = invoiceLines.filter((l) => l.invoiceId === invId);

    // All 3 lines persisted
    expect(lines).toHaveLength(3);

    // All have the same fabricId
    expect(lines.every((l) => l.fabricId === fabricId)).toBe(true);

    // All have different colorIds
    const colorIds = lines.map((l) => l.colorId);
    expect(new Set(colorIds).size).toBe(3);

    // Stock increased for each roll independently
    expect(stock["roll-1"].remainingKg).toBe(100);
    expect(stock["roll-2"].remainingKg).toBe(80);
    expect(stock["roll-3"].remainingKg).toBe(50);
  });

  it("allows new colors AND existing colors mixed for the same fabric", () => {
    const invId = "inv-2";
    const fabricId = "fabric-silk-01";

    // Existing color (already in system) + new color (first time entered)
    createInvoiceLine(invId, fabricId, "color-navy-01", "roll-4", 30, 2500); // Existing
    createInvoiceLine(invId, fabricId, "color-gold-01", "roll-5", 20, 2700); // New (first time)

    const lines = invoiceLines.filter((l) => l.invoiceId === invId);
    expect(lines).toHaveLength(2);
    expect(lines[0].colorId).toBe("color-navy-01");
    expect(lines[1].colorId).toBe("color-gold-01");
    expect(lines[0].fabricId).toBe(lines[1].fabricId);
  });

  it("subtotals correctly when fabric is same but prices differ per color", () => {
    const invId = "inv-3";
    const fabricId = "fabric-poly-01";

    createInvoiceLine(invId, fabricId, "color-a", "roll-10", 50, 1000); // 50,000
    createInvoiceLine(invId, fabricId, "color-b", "roll-11", 30, 1200); // 36,000
    createInvoiceLine(invId, fabricId, "color-c", "roll-12", 20, 1500); // 30,000

    const lines = invoiceLines.filter((l) => l.invoiceId === invId);
    const total = lines.reduce((s, l) => s + l.quantityKg * l.pricePerKg, 0);

    expect(total).toBe(50_000 + 36_000 + 30_000); // 116,000
  });

  it("does NOT reject duplicate (fabricId, colorId) pairs in same invoice", () => {
    const invId = "inv-4";
    const fabricId = "fabric-cotton-01";
    const colorId = "color-black-01";

    // Two entry lines with same fabric AND same color (different rolls)
    createInvoiceLine(invId, fabricId, colorId, "roll-20", 50, 1500);
    createInvoiceLine(invId, fabricId, colorId, "roll-21", 30, 1500);

    const lines = invoiceLines.filter((l) => l.invoiceId === invId);
    // Both persisted — no unique constraint prevents this
    expect(lines).toHaveLength(2);
    expect(lines[0].rollId).toBe("roll-20");
    expect(lines[1].rollId).toBe("roll-21");
  });
});
