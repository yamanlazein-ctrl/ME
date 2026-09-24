/**
 * Linked sale returns when ONE roll was sold on SEVERAL invoices.
 *
 * Found by the 5-year load audit: the per-invoice guard subtracted every
 * earlier return of the roll (from any invoice) from THIS invoice's quantity,
 * so a legitimate return on invoice #2 was refused after a return on invoice #1.
 * The guard must still refuse returning more than was sold.
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
import type { TenantContext } from "@/domain/types/index.js";

const tenantId = randomUUID();
const customerId = randomUUID();
const supplierId = randomUUID();
const fabricId = randomUUID();
const colorId = randomUUID();
const ctx: TenantContext = { tenantId, userId: randomUUID(), userRole: "admin", userName: "ret-tester" };
const invoiceRepo = new PostgresInvoiceRepository(db);
const rollRepo = new PostgresRollRepository(db);
const returnRepo = new PostgresReturnRepository(db);

let rollId = "";
const inv: string[] = [];

const sell = async (kg: number) =>
  invoiceRepo.create(
    {
      type: "sale",
      date: "2026-09-10",
      partyId: customerId,
      partyType: "customer",
      currency: "USD",
      lines: [{ fabricId, colorId, rollId, quantityKg: kg, pieces: 0, pricePerKg: 10 }],
    },
    ctx,
  );

const ret = (invoiceId: string, kg: number) =>
  returnRepo.create(
    {
      kind: "sale",
      date: "2026-09-12",
      partyId: customerId,
      originalInvoiceId: invoiceId,
      reason: "defect",
      currency: "USD",
      lines: [{ rollId, quantityKg: kg, pieces: 1, pricePerKg: 10 }],
    },
    ctx,
  );

describe("linked returns on a roll sold across several invoices", () => {
  beforeAll(async () => {
    await db.execute(sql`select 1`);
    await db.insert(tenants).values({ id: tenantId, name: "Ret Tenant", slug: `ret-${tenantId.slice(0, 8)}` });
    await db.insert(parties).values([
      { id: customerId, tenantId, name: "Ret Customer", code: "RET-C", kind: "customer", currency: "USD" },
      { id: supplierId, tenantId, name: "Ret Supplier", code: "RET-S", kind: "supplier", currency: "USD" },
    ]);
    await db.insert(fabrics).values({ id: fabricId, tenantId, name: "Cotton", minStockKg: "0" });
    await db.insert(colors).values({ id: colorId, tenantId, fabricId, name: "White" });
    const roll = await rollRepo.create(
      { colorId, rollNo: `R-${randomUUID().slice(0, 8)}`, initialKg: 100, remainingKg: 100, pieces: 1, pricePerKg: 4, currency: "USD", supplierId, entryDate: "2026-09-01" },
      ctx,
    );
    rollId = roll.id;
    inv.push((await sell(10)).id, (await sell(8)).id);
  });

  it("a return on invoice #2 is allowed after a return on invoice #1", async () => {
    await ret(inv[0]!, 6); // invoice #1: 10 sold, 6 returned
    const second = await ret(inv[1]!, 5); // invoice #2: 8 sold — must be accepted
    expect(second.id).toBeTruthy();
  });

  it("still refuses returning more than the invoice sold (per-invoice bound)", async () => {
    await expect(ret(inv[1]!, 4)).rejects.toThrow(/تتجاوز/); // 5 already returned of 8
  });

  it("still refuses exceeding everything sold to the customer from the roll", async () => {
    await expect(ret(inv[0]!, 5)).rejects.toThrow(/تتجاوز/); // #1 has only 4 left
    const ok = await ret(inv[0]!, 4);
    expect(ok.id).toBeTruthy();
  });
});
