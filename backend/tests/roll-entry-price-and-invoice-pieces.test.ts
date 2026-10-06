/**
 * (3) Each roll keeps the ACTUAL price it entered stock at — purchase line, printing-factory receive or
 *     stock-in — and editing the roll's cost price later never changes it.
 * (4) A sales invoice stores «عدد الأثواب» (sum of its lines' pieces) as real invoice data.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/infrastructure/orm/drizzle.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import { parties } from "@/infrastructure/orm/schemas/party.table.js";
import { fabrics } from "@/infrastructure/orm/schemas/fabric.table.js";
import { colors } from "@/infrastructure/orm/schemas/color.table.js";
import { invoices } from "@/infrastructure/orm/schemas/invoice.table.js";
import { PostgresInvoiceRepository } from "@/infrastructure/repositories/PostgresInvoiceRepository.js";
import { PostgresRollRepository } from "@/infrastructure/repositories/PostgresRollRepository.js";
import type { TenantContext } from "@/domain/types/index.js";

let reachable = false;
const tenantId = randomUUID();
const supplierId = randomUUID();
const customerId = randomUUID();
const fabricId = randomUUID();
const colorId = randomUUID();
const ctx: TenantContext = { tenantId, userId: randomUUID(), userRole: "admin", userName: "entry-price-tester" };

const newRoll = (rollRepo: PostgresRollRepository, o: { initialKg: number; remainingKg: number; pricePerKg: number; currency?: string }) =>
  rollRepo.create(
    { colorId, rollNo: `EP-${randomUUID().slice(0, 8)}`, pieces: 4, supplierId, entryDate: "2026-02-01", currency: o.currency ?? "USD", ...o },
    ctx,
  );

beforeAll(async () => {
  try {
    await db.execute(sql`select 1`);
    reachable = true;
  } catch {
    return;
  }
  await db.insert(tenants).values({ id: tenantId, name: "Entry price", slug: `ep-${tenantId.slice(0, 8)}` });
  await db.insert(parties).values([
    { id: supplierId, tenantId, name: "Sup EP", code: "SEP", kind: "supplier", currency: "USD" },
    { id: customerId, tenantId, name: "Cust EP", code: "CEP", kind: "customer", currency: "USD" },
  ]);
  await db.insert(fabrics).values({ id: fabricId, tenantId, name: "Linen", minStockKg: "0" });
  await db.insert(colors).values({ id: colorId, tenantId, fabricId, name: "Navy" });
});

describe("roll entry price (sales reference)", () => {
  it("a stock-in roll records its own price as the entry price", async () => {
    if (!reachable) return;
    const rollRepo = new PostgresRollRepository(db);
    const roll = await newRoll(rollRepo, { initialKg: 50, remainingKg: 50, pricePerKg: 3.25 });
    expect(roll).toMatchObject({ entryPricePerKg: 3.25, entryCurrency: "USD", entrySource: "stock_in" });
  });

  it("a purchase invoice records the ACTUAL line price for the exact roll it stocks", async () => {
    if (!reachable) return;
    const rollRepo = new PostgresRollRepository(db);
    const invoiceRepo = new PostgresInvoiceRepository(db);
    // the roll is created empty (as the purchase screen does) with a provisional price …
    const roll = await newRoll(rollRepo, { initialKg: 120, remainingKg: 0, pricePerKg: 4 });
    // … and the purchase line says what it actually cost
    const entry = await invoiceRepo.create(
      {
        type: "entry", date: "2026-02-02", partyId: supplierId, partyType: "supplier", currency: "USD", exchangeRate: 1,
        lines: [{ fabricId, colorId, rollId: roll.id, quantityKg: 120, pieces: 4, pricePerKg: 4.75 }],
      },
      ctx,
    );
    const after = await rollRepo.findById(roll.id, ctx);
    expect(after).toMatchObject({ entryPricePerKg: 4.75, entryCurrency: "USD", entrySource: "purchase", entryReference: entry.number });
  });

  it("editing the cost price later never changes the recorded entry price", async () => {
    if (!reachable) return;
    const rollRepo = new PostgresRollRepository(db);
    const roll = await newRoll(rollRepo, { initialKg: 30, remainingKg: 30, pricePerKg: 2 });
    await rollRepo.update(roll.id, { pricePerKg: 9.5 }, ctx);
    const after = await rollRepo.findById(roll.id, ctx);
    expect(after?.pricePerKg).toBe(9.5);
    expect(after).toMatchObject({ entryPricePerKg: 2, entrySource: "stock_in" });
  });

  it("each roll keeps its own entry price (different rolls of the same item can differ)", async () => {
    if (!reachable) return;
    const rollRepo = new PostgresRollRepository(db);
    const a = await newRoll(rollRepo, { initialKg: 10, remainingKg: 10, pricePerKg: 5 });
    const b = await newRoll(rollRepo, { initialKg: 10, remainingKg: 10, pricePerKg: 6.5 });
    expect((await rollRepo.findById(a.id, ctx))?.entryPricePerKg).toBe(5);
    expect((await rollRepo.findById(b.id, ctx))?.entryPricePerKg).toBe(6.5);
  });
});

describe("sales invoice «عدد الأثواب»", () => {
  it("is stored on the invoice as the sum of its lines' pieces", async () => {
    if (!reachable) return;
    const rollRepo = new PostgresRollRepository(db);
    const invoiceRepo = new PostgresInvoiceRepository(db);
    const r1 = await newRoll(rollRepo, { initialKg: 100, remainingKg: 100, pricePerKg: 3 });
    const r2 = await newRoll(rollRepo, { initialKg: 100, remainingKg: 100, pricePerKg: 3 });
    const sale = await invoiceRepo.create(
      {
        type: "sale", date: "2026-02-03", partyId: customerId, partyType: "customer", currency: "USD", exchangeRate: 1,
        lines: [
          { fabricId, colorId, rollId: r1.id, quantityKg: 20, pieces: 3, pricePerKg: 6 },
          { fabricId, colorId, rollId: r2.id, quantityKg: 15, pieces: 2, pricePerKg: 6 },
        ],
      },
      ctx,
    );
    expect(sale.piecesCount).toBe(5);
    const [row] = await db.select({ piecesCount: invoices.piecesCount }).from(invoices).where(and(eq(invoices.id, sale.id), eq(invoices.tenantId, tenantId)));
    expect(row?.piecesCount).toBe(5);
    expect((await invoiceRepo.findById(sale.id, ctx))?.piecesCount).toBe(5);

    // editing the lines keeps the stored count in step with them
    const edited = await invoiceRepo.update(
      sale.id,
      { date: "2026-02-03", lines: [{ fabricId, colorId, rollId: r1.id, quantityKg: 20, pieces: 4, pricePerKg: 6 }] },
      ctx,
      sale.version,
    );
    expect(edited.piecesCount).toBe(4);
  });
});
