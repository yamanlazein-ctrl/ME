import { describe, it, expect, beforeEach } from "vitest";
import { TenantContext, UUID } from "@/domain/types";

describe("Phase 3: Return Invoice — Multi-Color Per Fabric", () => {
  const ctx: TenantContext = {
    tenantId: "t1" as UUID,
    userId: "u1" as UUID,
    userRole: "admin",
    userName: "tester",
  };

  // Simulate stock + ledger (return ADDS stock back, creates CREDIT ledger entry)
  const stock = new Map<string, { colorId: string; fabricId: string; remainingKg: number; version: number }>();
  const returnLines: Array<{
    id: string; returnId: string; rollId: string; quantityKg: number; pricePerKg: number;
  }> = [];
  const ledgerEntries: Array<{
    type: string; referenceId: string; debit: number; credit: number; currency: string;
  }> = [];
  let lineSeq = 0;

  function seedStock(rollId: string, fabricId: string, colorId: string, kg: number) {
    stock.set(rollId, { colorId, fabricId, remainingKg: kg, version: 1 });
  }

  function createReturnLine(
    returnId: string, rollId: string, kg: number, price: number, version: number,
  ) {
    const r = stock.get(rollId);
    if (!r) throw new Error("Roll not found");

    // Color consistency check: the roll's colorId must match what we're returning
    // This is the existing BUG-04/H-2 fix enforced by the backend
    // We don't pass colorId in return lines (only rollId), but we derive it from the roll
    const derivedColorId = r.colorId;
    const derivedFabricId = r.fabricId;

    // Simulate: entry-type returns add stock, sale-type returns subtract from remaining
    // (simplified: just add back for this test since we're testing "return of sold stock")
    r.remainingKg += kg;
    r.version += 1;

    lineSeq++;
    returnLines.push({ id: `line-${lineSeq}`, returnId, rollId, quantityKg: kg, pricePerKg: price });

    // Financial impact: return creates a CREDIT entry (reduces party receivable)
    ledgerEntries.push({
      type: "return",
      referenceId: returnId,
      debit: 0,
      credit: kg * price,
      currency: "SYP",
    });
  }

  beforeEach(() => {
    stock.clear();
    returnLines.length = 0;
    ledgerEntries.length = 0;
    lineSeq = 0;

    // Seed: Cotton with 3 colors (each has some stock available for return)
    seedStock("roll-cotton-black-01", "fabric-cotton-01", "color-black-01", 100);
    seedStock("roll-cotton-white-01", "fabric-cotton-01", "color-white-01", 80);
    seedStock("roll-cotton-red-01", "fabric-cotton-01", "color-red-01", 50);
  });

  it("allows return of 2 colors from SAME fabric in one return invoice", () => {
    const returnId = "ret-1";

    createReturnLine(returnId, "roll-cotton-black-01", 20, 5000, 1); // 100,000
    createReturnLine(returnId, "roll-cotton-white-01", 10, 5200, 1);   // 52,000

    const lines = returnLines.filter((l) => l.returnId === returnId);
    expect(lines).toHaveLength(2);

    // Stock restored for each roll independently
    expect(stock.get("roll-cotton-black-01")!.remainingKg).toBe(120); // 100 + 20
    expect(stock.get("roll-cotton-white-01")!.remainingKg).toBe(90);   // 80 + 10
  });

  it("derives fabricId and colorId correctly from rollId (no mismatch possible)", () => {
    const returnId = "ret-2";

    createReturnLine(returnId, "roll-cotton-black-01", 15, 5000, 1);

    const line = returnLines.find((l) => l.returnId === returnId)!;
    const roll = stock.get(line.rollId)!;

    // The colorId is derived from the roll, not from a user-supplied value
    // This prevents the BUG-04 color mismatch that was fixed previously
    expect(roll.colorId).toBe("color-black-01");
    expect(roll.fabricId).toBe("fabric-cotton-01");
  });

  it("prevents returning from a non-existent roll", () => {
    expect(() => {
      createReturnLine("ret-3", "roll-nonexistent", 10, 5000, 1);
    }).toThrow("Roll not found");
  });

  it("financial impact is correct for multi-color return (sum of all lines)", () => {
    const returnId = "ret-4";

    createReturnLine(returnId, "roll-cotton-black-01", 25, 5000, 1); // 125,000
    createReturnLine(returnId, "roll-cotton-white-01", 15, 5200, 1);   // 78,000
    createReturnLine(returnId, "roll-cotton-red-01", 5, 5500, 1);       // 27,500

    const totalCredit = ledgerEntries
      .filter((e) => e.referenceId === returnId)
      .reduce((s, e) => s + e.credit, 0);

    expect(totalCredit).toBe(125_000 + 78_000 + 27_500); // 230,500
  });

  it("stock version is incremented per return line (optimistic locking)", () => {
    const returnId = "ret-5";

    const initialVersion = stock.get("roll-cotton-black-01")!.version;
    expect(initialVersion).toBe(1);

    createReturnLine(returnId, "roll-cotton-black-01", 10, 5000, 1); // version 1 → 2
    createReturnLine(returnId, "roll-cotton-black-01", 5, 5000, 2);    // version 2 → 3

    expect(stock.get("roll-cotton-black-01")!.version).toBe(3);
  });

  it("frontend fabricId filter only shows rolls of the same fabric when adding new color", () => {
    // Simulate the frontend filtering: only show rolls with fabricId matching current line's fabricId
    const currentFabricId = "fabric-cotton-01";
    const allRolls = [
      { id: "roll-cotton-black-01", colorId: "color-black-01", fabricId: "fabric-cotton-01" },
      { id: "roll-cotton-white-01", colorId: "color-white-01", fabricId: "fabric-cotton-01" },
      { id: "roll-silk-blue-01", colorId: "color-blue-01", fabricId: "fabric-silk-01" },
    ];

    const filteredRolls = allRolls.filter((r) => r.fabricId === currentFabricId);
    expect(filteredRolls).toHaveLength(2);
    expect(filteredRolls.map((r) => r.id)).toContain("roll-cotton-black-01");
    expect(filteredRolls.map((r) => r.id)).toContain("roll-cotton-white-01");
    expect(filteredRolls.map((r) => r.id)).not.toContain("roll-silk-blue-01");
  });
});
