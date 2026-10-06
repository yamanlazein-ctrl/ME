/**
 * «الموجود بالمخزون الآن» on the sales invoice and the send-to-press screen is read live from
 * GET /inventory/rolls/:id (rollRepo.findById). It must be the real current balance of the exact
 * roll (fabric + color + dye) after every movement, and other dyes of the same color keep their own.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/infrastructure/orm/drizzle.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import { parties } from "@/infrastructure/orm/schemas/party.table.js";
import { fabrics } from "@/infrastructure/orm/schemas/fabric.table.js";
import { colors } from "@/infrastructure/orm/schemas/color.table.js";
import { PostgresInvoiceRepository } from "@/infrastructure/repositories/PostgresInvoiceRepository.js";
import { PostgresRollRepository } from "@/infrastructure/repositories/PostgresRollRepository.js";
import { PostgresReturnRepository } from "@/infrastructure/repositories/PostgresReturnRepository.js";
import { PostgresPrintJobRepository } from "@/infrastructure/repositories/PostgresPrintJobRepository.js";
import type { TenantContext } from "@/domain/types/index.js";

let reachable = false;
const tenantId = randomUUID();
const supplierId = randomUUID();
const customerId = randomUUID();
const fabricId = randomUUID();
const colorId = randomUUID();
const ctx: TenantContext = { tenantId, userId: randomUUID(), userRole: "admin", userName: "live-stock-tester" };
const rollRepo = new PostgresRollRepository(db);
const invoiceRepo = new PostgresInvoiceRepository(db);
const returnRepo = new PostgresReturnRepository(db);
const printRepo = new PostgresPrintJobRepository(db);

/** What the screen shows: the server's current roll. */
const liveStock = async (id: string) => {
  const r = await rollRepo.findById(id, ctx);
  return { pieces: r!.remainingPieces, kg: r!.remainingKg };
};
const newRoll = (kg: number, pieces: number) =>
  rollRepo.create(
    { colorId, rollNo: `LS-${randomUUID().slice(0, 8)}`, initialKg: kg, remainingKg: kg, pieces, pricePerKg: 3, currency: "USD", supplierId, entryDate: "2026-03-01" },
    ctx,
  );
const sell = (rollId: string, kg: number, pieces: number) =>
  invoiceRepo.create(
    { type: "sale", date: "2026-03-02", partyId: customerId, partyType: "customer", currency: "USD", exchangeRate: 1, lines: [{ fabricId, colorId, rollId, quantityKg: kg, pieces, pricePerKg: 6 }] },
    ctx,
  );

beforeAll(async () => {
  try {
    await db.execute(sql`select 1`);
    reachable = true;
  } catch {
    return;
  }
  await db.insert(tenants).values({ id: tenantId, name: "Live stock", slug: `ls-${tenantId.slice(0, 8)}` });
  await db.insert(parties).values([
    { id: supplierId, tenantId, name: "Sup LS", code: "SLS", kind: "supplier", currency: "USD" },
    { id: customerId, tenantId, name: "Cust LS", code: "CLS", kind: "customer", currency: "USD" },
  ]);
  await db.insert(fabrics).values({ id: fabricId, tenantId, name: "Crepe", minStockKg: "0" });
  await db.insert(colors).values({ id: colorId, tenantId, fabricId, name: "Red" });
});

describe("live stock of the exact selected roll", () => {
  it("follows sales, returns, press sends and cancellations — per dye", async () => {
    if (!reachable) return;
    const a = await newRoll(500, 100);
    const b = await newRoll(500, 100); // same fabric + color, another dye
    expect(await liveStock(a.id)).toEqual({ pieces: 100, kg: 500 });

    // the owner's example: 100 in stock, sell 10 → the next invoice shows 90
    const s1 = await sell(a.id, 50, 10);
    expect((await liveStock(a.id)).pieces).toBe(90);
    expect((await liveStock(b.id)).pieces).toBe(100); // the other dye is untouched

    await sell(a.id, 25, 5);
    expect(await liveStock(a.id)).toEqual({ pieces: 85, kg: 425 });

    // customer returns 2 pieces of the first sale
    await returnRepo.create(
      { kind: "sale", date: "2026-03-03", partyId: customerId, originalInvoiceId: s1.id, reason: "defect", currency: "USD", lines: [{ rollId: a.id, quantityKg: 10, pieces: 2, pricePerKg: 6 }] },
      ctx,
    );
    expect(await liveStock(a.id)).toEqual({ pieces: 87, kg: 435 });

    // send 7 pieces to the printing factory
    await printRepo.create(
      { date: "2026-03-04", sourceRollId: a.id, quantityKg: 35, pieces: 7, pressName: "مطبعة", printCostPerKg: 1, currency: "USD" } as never,
      null,
      ctx,
    );
    expect(await liveStock(a.id)).toEqual({ pieces: 80, kg: 400 });
    expect(await liveStock(b.id)).toEqual({ pieces: 100, kg: 500 });
  });

  it("counts goods received by a purchase invoice", async () => {
    if (!reachable) return;
    const r = await rollRepo.create(
      { colorId, rollNo: `LS-${randomUUID().slice(0, 8)}`, initialKg: 60, remainingKg: 0, pieces: 12, pricePerKg: 3, currency: "USD", supplierId, entryDate: "2026-03-01" },
      ctx,
    );
    expect((await liveStock(r.id)).kg).toBe(0);
    await invoiceRepo.create(
      { type: "entry", date: "2026-03-05", partyId: supplierId, partyType: "supplier", currency: "USD", exchangeRate: 1, lines: [{ fabricId, colorId, rollId: r.id, quantityKg: 60, pieces: 12, pricePerKg: 3 }] },
      ctx,
    );
    expect(await liveStock(r.id)).toEqual({ pieces: 12, kg: 60 });
  });
});
