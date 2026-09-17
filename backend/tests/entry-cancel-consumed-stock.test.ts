/**
 * Entry-invoice cancel must fail closed when stock was already consumed.
 * Regression for audit F-INV-CANCEL-ENTRY-DOWNSTREAM.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, and, sql } from "drizzle-orm";
import { db } from "@/infrastructure/orm/drizzle.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import { parties } from "@/infrastructure/orm/schemas/party.table.js";
import { fabrics } from "@/infrastructure/orm/schemas/fabric.table.js";
import { colors } from "@/infrastructure/orm/schemas/color.table.js";
import { rolls } from "@/infrastructure/orm/schemas/roll.table.js";
import { PostgresInvoiceRepository } from "@/infrastructure/repositories/PostgresInvoiceRepository.js";
import { PostgresRollRepository } from "@/infrastructure/repositories/PostgresRollRepository.js";
import { BusinessRuleError } from "@/domain/errors/index.js";
import type { TenantContext } from "@/domain/types/index.js";

let reachable = false;
const tenantId = randomUUID();
const supplierId = randomUUID();
const customerId = randomUUID();
const fabricId = randomUUID();
const colorId = randomUUID();
const ctx: TenantContext = {
  tenantId,
  userId: randomUUID(),
  userRole: "admin",
  userName: "cancel-tester",
};

describe("entry invoice cancel vs consumed stock", () => {
  beforeAll(async () => {
    try {
      await db.execute(sql`select 1`);
      reachable = true;
      await db.insert(tenants).values({
        id: tenantId,
        name: "Cancel Stock Tenant",
        slug: `cancel-${tenantId.slice(0, 8)}`,
      });
      await db.insert(parties).values([
        {
          id: supplierId,
          tenantId,
          name: "Sup",
          code: "S1",
          kind: "supplier",
          currency: "USD",
        },
        {
          id: customerId,
          tenantId,
          name: "Cust",
          code: "C1",
          kind: "customer",
          currency: "USD",
        },
      ]);
      await db.insert(fabrics).values({
        id: fabricId,
        tenantId,
        name: "Cotton",
        minStockKg: "0",
      });
      await db.insert(colors).values({
        id: colorId,
        tenantId,
        fabricId,
        name: "White",
      });
    } catch {
      reachable = false;
    }
  });

  it("rejects cancelling an entry after a sale consumed part of the roll", async () => {
    if (!reachable) return;

    const invoiceRepo = new PostgresInvoiceRepository(db);
    const rollRepo = new PostgresRollRepository(db);

    const roll = await rollRepo.create(
      {
        colorId,
        rollNo: `R-${randomUUID().slice(0, 8)}`,
        initialKg: 100,
        remainingKg: 0,
        pieces: 1,
        pricePerKg: 5,
        currency: "USD",
        supplierId,
        entryDate: "2026-01-10",
      },
      ctx,
    );

    const entry = await invoiceRepo.create(
      {
        type: "entry",
        date: "2026-01-10",
        partyId: supplierId,
        partyType: "supplier",
        currency: "USD",
        exchangeRate: 1,
        lines: [
          {
            fabricId,
            colorId,
            rollId: roll.id,
            quantityKg: 40,
            pieces: 1,
            pricePerKg: 5,
          },
        ],
      },
      ctx,
    );

    await invoiceRepo.create(
      {
        type: "sale",
        date: "2026-01-11",
        partyId: customerId,
        partyType: "customer",
        currency: "USD",
        exchangeRate: 1,
        lines: [
          {
            fabricId,
            colorId,
            rollId: roll.id,
            quantityKg: 10,
            pieces: 1,
            pricePerKg: 8,
          },
        ],
      },
      ctx,
    );

    const before = await rollRepo.findById(roll.id, ctx);
    expect(before?.remainingKg).toBe(30);

    await expect(
      invoiceRepo.cancel(entry.id, ctx.userId, ctx, entry.version),
    ).rejects.toBeInstanceOf(BusinessRuleError);

    const after = await rollRepo.findById(roll.id, ctx);
    expect(after?.remainingKg).toBe(30);

    const { invoices } = await import("@/infrastructure/orm/schemas/invoice.table.js");
    const [row] = await db
      .select()
      .from(invoices)
      .where(and(eq(invoices.id, entry.id), eq(invoices.tenantId, tenantId)))
      .limit(1);
    expect(row?.status).toBe("active");
  });

  it("allows cancelling an entry when the full quantity remains on the roll", async () => {
    if (!reachable) return;

    const invoiceRepo = new PostgresInvoiceRepository(db);
    const rollRepo = new PostgresRollRepository(db);

    const roll = await rollRepo.create(
      {
        colorId,
        rollNo: `R-full-${randomUUID().slice(0, 8)}`,
        initialKg: 50,
        remainingKg: 0,
        pieces: 1,
        pricePerKg: 4,
        currency: "USD",
        supplierId,
        entryDate: "2026-02-01",
      },
      ctx,
    );

    const entry = await invoiceRepo.create(
      {
        type: "entry",
        date: "2026-02-01",
        partyId: supplierId,
        partyType: "supplier",
        currency: "USD",
        exchangeRate: 1,
        lines: [
          {
            fabricId,
            colorId,
            rollId: roll.id,
            quantityKg: 25,
            pieces: 1,
            pricePerKg: 4,
          },
        ],
      },
      ctx,
    );

    const cancelled = await invoiceRepo.cancel(entry.id, ctx.userId, ctx, entry.version);
    expect(cancelled.status).toBe("cancelled");

    const after = await rollRepo.findById(roll.id, ctx);
    expect(after?.remainingKg).toBe(0);
  });
});
