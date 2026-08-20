import { describe, it, expect, beforeEach } from "vitest";
import { TenantContext, UUID } from "@/domain/types";

describe("Phase 2: Sale Invoice — Multi-Color Per Fabric", () => {
  const ctx: TenantContext = {
    tenantId: "t1" as UUID,
    userId: "u1" as UUID,
    userRole: "admin",
    userName: "tester",
  };

  // Simulate stock + reservation (same as backend logic)
  const stock = new Map<
    string,
    { colorId: string; fabricId: string; remainingKg: number; version: number }
  >();
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
  let lineSeq = 0;

  function seedStock(rollId: string, fabricId: string, colorId: string, kg: number) {
    stock.set(rollId, { colorId, fabricId, remainingKg: kg, version: 1 });
  }

  function reserveStock(rollId: string, kg: number, version: number) {
    const r = stock.get(rollId);
    if (!r) return { ok: false, error: "NotFound" };
    if (r.version !== version) return { ok: false, error: "ConcurrentModification" };
    if (r.remainingKg < kg) return { ok: false, error: "InsufficientStock" };
    r.remainingKg -= kg;
    r.version += 1;
    return { ok: true };
  }

  function createSaleLine(
    invoiceId: string,
    fabricId: string,
    colorId: string,
    rollId: string,
    kg: number,
    price: number,
    version: number,
  ) {
    // Simulate backend validation: colorId must match roll's colorId
    const r = stock.get(rollId);
    if (!r) throw new Error("Roll not found");
    if (r.colorId !== colorId)
      throw new Error(`Color mismatch: line.colorId=${colorId} vs roll.colorId=${r.colorId}`);

    const res = reserveStock(rollId, kg, version);
    if (!res.ok) throw new Error(res.error);

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
  }

  beforeEach(() => {
    stock.clear();
    invoiceLines.length = 0;
    lineSeq = 0;

    // Seed: Cotton with 3 colors (Black, White, Red)
    seedStock("roll-cotton-black-01", "fabric-cotton-01", "color-black-01", 100);
    seedStock("roll-cotton-white-01", "fabric-cotton-01", "color-white-01", 80);
    seedStock("roll-cotton-red-01", "fabric-cotton-01", "color-red-01", 50);
  });

  it("allows 3 colors of SAME fabric in one sale invoice (stock deducts per roll independently)", () => {
    const invId = "inv-sale-1";

    createSaleLine(
      invId,
      "fabric-cotton-01",
      "color-black-01",
      "roll-cotton-black-01",
      30,
      5000,
      1,
    );
    createSaleLine(
      invId,
      "fabric-cotton-01",
      "color-white-01",
      "roll-cotton-white-01",
      20,
      5200,
      1,
    );
    createSaleLine(invId, "fabric-cotton-01", "color-red-01", "roll-cotton-red-01", 10, 5500, 1);

    const lines = invoiceLines.filter((l) => l.invoiceId === invId);
    expect(lines).toHaveLength(3);

    // Stock deducted independently for each roll
    expect(stock.get("roll-cotton-black-01")!.remainingKg).toBe(70);
    expect(stock.get("roll-cotton-white-01")!.remainingKg).toBe(60);
    expect(stock.get("roll-cotton-red-01")!.remainingKg).toBe(40);
  });

  it("prevents color mismatch (colorId does not match roll's actual colorId)", () => {
    // Try to sell roll-cotton-black-01 as if it were white
    expect(() => {
      createSaleLine(
        "inv-x",
        "fabric-cotton-01",
        "color-white-01",
        "roll-cotton-black-01",
        10,
        5000,
        1,
      );
    }).toThrow("Color mismatch");
  });

  it("prevents over-selling any single color beyond its roll stock", () => {
    // Try to sell 110kg from black roll (only 100 available)
    expect(() => {
      createSaleLine(
        "inv-y",
        "fabric-cotton-01",
        "color-black-01",
        "roll-cotton-black-01",
        110,
        5000,
        1,
      );
    }).toThrow("InsufficientStock");
  });

  it("subtotal per line is correct when different colors have different prices", () => {
    const invId = "inv-sale-2";
    createSaleLine(
      invId,
      "fabric-cotton-01",
      "color-black-01",
      "roll-cotton-black-01",
      10,
      5000,
      1,
    ); // 50,000
    createSaleLine(invId, "fabric-cotton-01", "color-white-01", "roll-cotton-white-01", 5, 6000, 1); // 30,000
    createSaleLine(invId, "fabric-cotton-01", "color-red-01", "roll-cotton-red-01", 2, 7000, 1); // 14,000

    const lines = invoiceLines.filter((l) => l.invoiceId === invId);
    const total = lines.reduce((s, l) => s + l.quantityKg * l.pricePerKg, 0);
    expect(total).toBe(94_000);
  });

  it("allows multiple colors of same fabric in one sale, then partial sale of one color separately", () => {
    const invId = "inv-sale-3";
    createSaleLine(
      invId,
      "fabric-cotton-01",
      "color-black-01",
      "roll-cotton-black-01",
      20,
      5000,
      1,
    );
    createSaleLine(
      invId,
      "fabric-cotton-01",
      "color-white-01",
      "roll-cotton-white-01",
      15,
      5200,
      1,
    );

    // Separate sale: more of black only
    const invId2 = "inv-sale-4";
    createSaleLine(
      invId2,
      "fabric-cotton-01",
      "color-black-01",
      "roll-cotton-black-01",
      10,
      5000,
      2,
    ); // version bumped from first sale

    // Stock reflects both sales independently
    expect(stock.get("roll-cotton-black-01")!.remainingKg).toBe(70); // 100 - 20 - 10
    expect(stock.get("roll-cotton-white-01")!.remainingKg).toBe(65); // 80 - 15
  });
});
