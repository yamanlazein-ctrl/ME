/**
 * OLD-PLAN Phase 0.1 — return P&L follows returns.date, not invoice.date.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/infrastructure/orm/drizzle.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import { parties } from "@/infrastructure/orm/schemas/party.table.js";
import { invoices } from "@/infrastructure/orm/schemas/invoice.table.js";
import { invoiceLines } from "@/infrastructure/orm/schemas/invoice-line.table.js";
import { ledgerEntries } from "@/infrastructure/orm/schemas/ledger-entry.table.js";
import { returns } from "@/infrastructure/orm/schemas/return.table.js";
import { returnLines } from "@/infrastructure/orm/schemas/return-line.table.js";
import { fabrics } from "@/infrastructure/orm/schemas/fabric.table.js";
import { colors } from "@/infrastructure/orm/schemas/color.table.js";
import { rolls } from "@/infrastructure/orm/schemas/roll.table.js";
import { PostgresProfitRepository } from "@/infrastructure/repositories/PostgresProfitRepository.js";
import type { TenantContext } from "@/domain/types/index.js";

const tenantId = randomUUID();
const customerId = randomUUID();
const fabricId = randomUUID();
const colorId = randomUUID();
const rollId = randomUUID();
const invoiceId = randomUUID();
const returnId = randomUUID();
const ctx: TenantContext = {
  tenantId,
  userId: randomUUID(),
  userRole: "admin",
  userName: "profit-period",
};

describe("profit return period attribution (returns.date)", () => {
  beforeAll(async () => {
    await db.execute(sql`select 1`);
    await db.insert(tenants).values({
      id: tenantId,
      name: "Profit Period Tenant",
      slug: `pp-${tenantId.slice(0, 8)}`,
    });
    await db.insert(parties).values({
      id: customerId,
      tenantId,
      name: "PP Customer",
      code: "PP-C",
      kind: "customer",
      currency: "SYP",
    });
    await db.insert(fabrics).values({ id: fabricId, tenantId, name: "Cotton", minStockKg: "0" });
    await db.insert(colors).values({ id: colorId, tenantId, fabricId, name: "White" });
    await db.insert(rolls).values({
      id: rollId,
      tenantId,
      colorId,
      rollNo: "R-PP-1",
      initialKg: "100",
      remainingKg: "90",
      pieces: 1,
      remainingPieces: 1,
      pricePerKg: "5000",
      currency: "SYP",
      status: "in_stock",
      entryDate: "2024-06-01",
    });
    await db.insert(invoices).values({
      id: invoiceId,
      tenantId,
      number: "INV-2024-0001",
      type: "sale",
      date: "2024-06-15",
      partyId: customerId,
      partyType: "customer",
      currency: "SYP",
      subtotal: 100_000,
      discount: 0,
      total: 100_000,
      paid: 0,
      exchangeRate: 10_000,
      status: "active",
    });
    await db.insert(invoiceLines).values({
      tenantId,
      invoiceId,
      fabricId,
      colorId,
      rollId,
      quantityKg: "10",
      pieces: 1,
      pricePerKg: "10000",
      costPerKg: "4000",
    });
    await db.insert(ledgerEntries).values([
      {
        tenantId,
        partyId: customerId,
        date: "2024-06-15",
        type: "sales_invoice",
        debit: 100_000,
        credit: 0,
        currency: "SYP",
        referenceType: "sales_invoice",
        referenceId: invoiceId,
        referenceNumber: "INV-2024-0001",
        status: "active",
      },
      {
        tenantId,
        partyId: null,
        date: "2024-06-15",
        type: "cogs_expense",
        debit: 40_000,
        credit: 0,
        currency: "SYP",
        referenceType: "sales_invoice",
        referenceId: invoiceId,
        referenceNumber: "INV-2024-0001",
        status: "active",
      },
    ]);
    await db.insert(returns).values({
      id: returnId,
      tenantId,
      number: "RET-2027-0001",
      kind: "sale",
      date: "2027-03-01",
      partyId: customerId,
      originalInvoiceId: invoiceId,
      reason: "defect",
      currency: "SYP",
      status: "active",
    });
    await db.insert(returnLines).values({
      tenantId,
      returnId,
      fabricId,
      colorId,
      rollId,
      quantityKg: "2",
      pieces: 1,
      pricePerKg: "10000",
    });
    await db.insert(ledgerEntries).values({
      tenantId,
      partyId: null,
      date: "2027-03-01",
      type: "cogs_expense",
      debit: 0,
      credit: 8_000,
      currency: "SYP",
      referenceType: "sales_return",
      referenceId: returnId,
      referenceNumber: "RET-2027-0001",
      status: "active",
    });
  });

  it("2024 period includes full invoice and ignores 2027 return", async () => {
    const repo = new PostgresProfitRepository(db);
    const s = await repo.getSummary(
      { fromDate: "2024-01-01", toDate: "2024-12-31", currency: "SYP" },
      ctx,
    );
    const syp = s.byCurrency.find((c) => c.currency === "SYP");
    expect(syp?.salesRevenue).toBe(100_000);
    expect(syp?.cogs).toBe(40_000);
    expect(syp?.returnCount ?? 0).toBe(0);
  });

  it("2027 period applies the return even though invoice is in 2024", async () => {
    const repo = new PostgresProfitRepository(db);
    const s = await repo.getSummary(
      { fromDate: "2027-01-01", toDate: "2027-12-31", currency: "SYP" },
      ctx,
    );
    const syp = s.byCurrency.find((c) => c.currency === "SYP");
    expect(syp?.invoiceCount).toBe(0);
    expect(syp?.returnCount).toBe(1);
    expect(syp?.salesRevenue).toBe(-20_000);
    expect(syp?.cogs).toBe(-8_000);
  });

  it("changing live roll price does not change 2024 COGS (cost_per_kg snapshot)", async () => {
    await db
      .update(rolls)
      .set({ pricePerKg: "999999" })
      .where(sql`id = ${rollId}::uuid`);
    const repo = new PostgresProfitRepository(db);
    const s = await repo.getSummary(
      { fromDate: "2024-01-01", toDate: "2024-12-31", currency: "SYP" },
      ctx,
    );
    expect(s.byCurrency.find((c) => c.currency === "SYP")?.cogs).toBe(40_000);
  });
});
