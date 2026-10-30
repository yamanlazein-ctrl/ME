import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createPartyUseCase } from "@backend/application/use-cases/parties/partyUseCases";
import { createFabricUseCase } from "@backend/application/use-cases/inventory/fabricUseCases";
import { createColorUseCase } from "@backend/application/use-cases/inventory/colorUseCases";
import { createRollUseCase } from "@backend/application/use-cases/inventory/rollUseCases";
import {
  findLots,
  listCategories,
  listFabrics,
  loadColorLots,
  loadFabric,
  loadLot,
  lotState,
} from "../../src/core/stock";
import { makeTestPhone, type TestPhone } from "../helpers/testPhone";

const must = <T>(r: { ok: true; data: T } | { ok: false; error: string }) => {
  if (!r.ok) throw new Error(r.error);
  return r.data;
};

describe("stock reads (desktop inventory page on the phone)", () => {
  let t: TestPhone;
  let fabricId = "";
  let colorId = "";
  let lotA = "";

  beforeAll(async () => {
    t = await makeTestPhone();
    const ctx = t.phone.context();
    const supplier = must(
      await createPartyUseCase(
        t.phone.repos.partyRepo,
        { kind: "supplier", name: "معمل الشرق" } as never,
        ctx,
      ),
    );
    fabricId = must(
      await createFabricUseCase(
        t.phone.repos.fabricRepo,
        { name: "جاكار", category: "مفروشات", minStockKg: 100 } as never,
        ctx,
      ),
    ).id;
    must(
      await createFabricUseCase(
        t.phone.repos.fabricRepo,
        { name: "شيفون فارغ", minStockKg: 0 },
        ctx,
      ),
    );
    colorId = must(
      await createColorUseCase(
        t.phone.repos.colorRepo,
        { fabricId, name: "خمري", code: "C-77" } as never,
        ctx,
      ),
    ).id;
    const roll = (rollNo: string, kg: number, pieces: number) =>
      createRollUseCase(
        t.phone.repos.rollRepo,
        {
          colorId,
          rollNo,
          initialKg: kg,
          pieces,
          pricePerKg: 3.25,
          currency: "USD",
          supplierId: supplier.id,
          entryDate: "2026-02-01",
          widthCm: 150,
        } as never,
        ctx,
      );
    lotA = must(await roll("DL-1001", 60, 3)).id;
    must(await roll("DL-1002", 8, 1));
  });

  afterAll(async () => t?.close());

  it("the desktop's lot state rule", () => {
    expect(lotState(0, 100)).toBe("out");
    expect(lotState(10, 0)).toBe("low");
    expect(lotState(50, 100)).toBe("low");
    expect(lotState(51, 100)).toBe("active");
  });

  it("fabric totals: remaining kg, pieces, active lots, colours, low flag", async () => {
    const rows = await listFabrics(t.phone, "");
    const f = rows.find((r) => r.id === fabricId)!;
    expect(f).toMatchObject({
      name: "جاكار",
      category: "مفروشات",
      remainingKg: 68,
      pieces: 4,
      activeLots: 2,
      colorCount: 1,
      low: true,
    });
  });

  it("one search finds a fabric by colour name, colour code and dye-lot number", async () => {
    for (const q of ["خمري", "C-77", "DL-1002", "مفروشات"]) {
      const ids = (await listFabrics(t.phone, q)).map((r) => r.id);
      expect(ids, q).toEqual([fabricId]);
    }
    expect(await listFabrics(t.phone, "لا يوجد")).toEqual([]);
    const lots = await findLots(t.phone, "DL-100");
    expect(lots.map((l) => l.rollNo).sort()).toEqual(["DL-1001", "DL-1002"]);
  });

  it("filters: in stock / low / out of stock, and categories", async () => {
    expect((await listFabrics(t.phone, "", "out")).map((r) => r.name)).toEqual(["شيفون فارغ"]);
    expect((await listFabrics(t.phone, "", "low")).map((r) => r.name)).toEqual(["جاكار"]);
    expect((await listFabrics(t.phone, "", "inStock")).map((r) => r.name)).toEqual(["جاكار"]);
    expect(await listCategories(t.phone)).toEqual(["مفروشات"]);
  });

  it("fabric → colours → lots with supplier, date and state", async () => {
    const fabric = await loadFabric(t.phone, fabricId);
    expect(fabric?.colors).toEqual([
      expect.objectContaining({ name: "خمري", code: "C-77", remainingKg: 68, activeLots: 2 }),
    ]);
    const lots = await loadColorLots(t.phone, colorId);
    expect(lots?.lots.map((l) => [l.rollNo, l.supplierName, l.entryDate, l.state])).toEqual([
      ["DL-1001", "معمل الشرق", "2026-02-01", "active"],
      ["DL-1002", "معمل الشرق", "2026-02-01", "low"],
    ]);
  });

  it("a lot's detail: quantities, specs, prices, supplier, movements with their balance", async () => {
    const lot = await loadLot(t.phone, lotA);
    expect(lot).toMatchObject({
      rollNo: "DL-1001",
      fabricName: "جاكار",
      colorName: "خمري",
      initialKg: 60,
      remainingKg: 60,
      outKg: 0,
      widthCm: 150,
      costPerKg: 3.25,
      currency: "USD",
      supplierName: "معمل الشرق",
    });
    for (const m of lot!.movements) expect(m.balanceAfterKg).toBeGreaterThanOrEqual(0);
  });
});
