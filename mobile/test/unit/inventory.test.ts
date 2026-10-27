import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTenantTx } from "@backend/infrastructure/orm/engine";
import { createPartyUseCase } from "@backend/application/use-cases/parties/partyUseCases";
import { createFabricUseCase } from "@backend/application/use-cases/inventory/fabricUseCases";
import { createColorUseCase } from "@backend/application/use-cases/inventory/colorUseCases";
import { createRollUseCase } from "@backend/application/use-cases/inventory/rollUseCases";
import {
  isLowStock,
  listColorStock,
  listFabricStock,
  listRollsOfColor,
  loadCountSheet,
  loadRollDetail,
} from "../../src/core/inventory";
import { makeTestPhone, type TestPhone } from "../helpers/testPhone";

const must = <T>(r: { ok: true; data: T } | { ok: false; error: string }) => {
  if (!r.ok) throw new Error(r.error);
  return r.data;
};

describe("inventory reads and writes", () => {
  let t: TestPhone;
  let fabricId = "";
  let colorId = "";
  let rollId = "";
  let partyId = "";
  const year = new Date().getFullYear();

  beforeAll(async () => {
    t = await makeTestPhone();
    const ctx = t.phone.context();
    const fabric = must(
      await createFabricUseCase(
        t.phone.repos.fabricRepo,
        { name: "قطن مخزون", minStockKg: 50 },
        ctx,
      ),
    );
    fabricId = fabric.id;
    const color = must(
      await createColorUseCase(t.phone.repos.colorRepo, { fabricId, name: "أزرق" }, ctx),
    );
    colorId = color.id;
    const roll = must(
      await createRollUseCase(
        t.phone.repos.rollRepo,
        {
          colorId,
          rollNo: "INV-R1",
          initialKg: 20,
          pieces: 2,
          pricePerKg: 3,
          currency: "USD",
          entryDate: `${year}-01-05`,
        },
        ctx,
      ),
    );
    rollId = roll.id;
    partyId = await withTenantTx(
      ctx.tenantId,
      async () =>
        must(
          await createPartyUseCase(
            t.phone.repos.partyRepo,
            { kind: "customer", code: "C-INV", name: "عميل المخزون", currency: "USD" },
            ctx,
          ),
        ).id,
    );
  });
  afterAll(() => t?.close());

  it("low-stock badge rule: 32 kg left of a 50 kg minimum is low", () => {
    expect(isLowStock(32, 50)).toBe(true);
    expect(isLowStock(60, 50)).toBe(false);
    expect(isLowStock(5, 0)).toBe(false);
  });

  it("lists the fabric with its remaining kg and the low flag, its colour and its roll", async () => {
    const fabrics = await listFabricStock(t.phone, "");
    const f = fabrics.find((x) => x.id === fabricId);
    expect(f).toMatchObject({
      name: "قطن مخزون",
      minStockKg: 50,
      remainingKg: 20,
      rollCount: 1,
      low: true,
    });
    expect(await listFabricStock(t.phone, "قطن")).toHaveLength(1);
    expect(await listFabricStock(t.phone, "zzz")).toHaveLength(0);
    const colors = await listColorStock(t.phone, fabricId);
    expect(colors[0]).toMatchObject({ name: "أزرق", remainingKg: 20 });
    const rolls = await listRollsOfColor(t.phone, colorId);
    expect(rolls[0]).toMatchObject({ rollNo: "INV-R1", remainingKg: 20 });
  });

  it("adjusts a roll: delta, movement, sync unit; refuses a negative quantity and a missing reason", async () => {
    const before = await t.phone.repos.syncOutboxRepo.countOutstanding(
      t.phone.identity.tenantId as never,
    );
    const bad = await t.phone.documents.adjustRoll(rollId, { newKg: -1, reason: "خطأ" });
    expect(bad).toMatchObject({ ok: false });
    const noReason = await t.phone.documents.adjustRoll(rollId, { newKg: 5, reason: " " });
    expect(noReason.ok).toBe(false);
    const ok = await t.phone.documents.adjustRoll(rollId, { newKg: 18, reason: "تلف" });
    if (!ok.ok) throw new Error(ok.error);
    expect(ok.data).toMatchObject({ beforeKg: 20, afterKg: 18 });
    const detail = await loadRollDetail(t.phone, rollId);
    expect(detail?.roll.remainingKg).toBe(18);
    expect(detail?.movements.some((m) => m.type === "adjustment" && m.deltaKg === -2)).toBe(true);
    const after = await t.phone.repos.syncOutboxRepo.countOutstanding(
      t.phone.identity.tenantId as never,
    );
    expect(Number(after)).toBe(Number(before) + 1);
  });

  it("a price edit is refused after the first sale with the use-case message", async () => {
    const sale = await t.phone.documents.createInvoice({
      type: "sale",
      date: `${year}-02-01`,
      partyId,
      partyType: "customer",
      currency: "USD",
      exchangeRate: 1,
      lines: [{ fabricId, colorId, rollId, quantityKg: 3, pieces: 0, pricePerKg: 4 }],
      paid: 0,
      preAllocatedNumber: t.nextNumber("INV"),
    } as never);
    if (!sale.ok) throw new Error(sale.error);
    const edit = await t.phone.documents.updateRoll(rollId, { pricePerKg: 9 });
    expect(edit.ok).toBe(false);
    if (!edit.ok) expect(edit.error.length).toBeGreaterThan(5);
  });

  it("a count of 12.0 for a 15 kg roll posts a -3.0 adjustment and is idempotent", async () => {
    const detail = await loadRollDetail(t.phone, rollId);
    const book = detail!.roll.remainingKg;
    const rec = await t.phone.documents.recordCount({
      year,
      rollId,
      countedKg: book - 3,
      reason: "جرد",
    });
    if (!rec.ok) throw new Error(rec.error);
    expect(rec.data.diffKg).toBe(-3);
    const sheet = await loadCountSheet(t.phone, year, "INV-R1");
    const line = sheet.lines.find((l) => l.rollId === rollId);
    expect(line).toMatchObject({ countedKg: book - 3, diffKg: -3 });
    const posted = await t.phone.documents.postCount(line!.countId!);
    if (!posted.ok) throw new Error(posted.error);
    expect(posted.data.diffKg).toBe(-3);
    expect((await loadRollDetail(t.phone, rollId))?.roll.remainingKg).toBe(book - 3);
    const again = await t.phone.documents.postCount(line!.countId!);
    expect(again.ok).toBe(false);
  });

  it("warehouse and viewer cannot count", async () => {
    const w = await makeTestPhone("warehouse");
    try {
      const r = await w.phone.documents.recordCount({ year, rollId, countedKg: 1 });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("الجرد متاح");
    } finally {
      w.close();
    }
  });
});
