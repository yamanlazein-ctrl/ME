/**
 * CODEBASE_AUDIT_REPORT H-07 — a closed day / financial year stays frozen on every mutation path, not
 * only on create. Engine-agnostic (SQLite + PG).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "@/infrastructure/orm/drizzle.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import { parties } from "@/infrastructure/orm/schemas/party.table.js";
import { fabrics } from "@/infrastructure/orm/schemas/fabric.table.js";
import { colors } from "@/infrastructure/orm/schemas/color.table.js";
import { invoices } from "@/infrastructure/orm/schemas/invoice.table.js";
import { financialYears } from "@/infrastructure/orm/schemas/financial-year.table.js";
import { PostgresInvoiceRepository } from "@/infrastructure/repositories/PostgresInvoiceRepository.js";
import { PostgresRollRepository } from "@/infrastructure/repositories/PostgresRollRepository.js";
import { PostgresReturnRepository } from "@/infrastructure/repositories/PostgresReturnRepository.js";
import { PostgresStatementRepository } from "@/infrastructure/repositories/PostgresStatementRepository.js";
import { PostgresCashboxRepository } from "@/infrastructure/repositories/PostgresCashboxRepository.js";
import type { TenantContext } from "@/domain/types/index.js";

const tenantId = randomUUID();
const customerId = randomUUID();
const fabricId = randomUUID();
const colorId = randomUUID();
const ctx: TenantContext = {
  tenantId,
  userId: randomUUID(),
  userRole: "admin",
  userName: "period-tester",
};
const invoiceRepo = new PostgresInvoiceRepository(db);
const cashbox = new PostgresCashboxRepository(db);

describe("closed periods stay frozen on delete, cancel, return and settle", () => {
  let invoiceId = "";
  let rollId = "";

  beforeAll(async () => {
    await db.execute(sql`select 1`);
    await db
      .insert(tenants)
      .values({ id: tenantId, name: "Period", slug: `per-${tenantId.slice(0, 8)}` });
    await db.insert(parties).values({
      id: customerId,
      tenantId,
      name: "C",
      code: "PER-C",
      kind: "customer",
      currency: "USD",
    });
    await db.insert(fabrics).values({ id: fabricId, tenantId, name: "Cotton", minStockKg: "0" });
    await db.insert(colors).values({ id: colorId, tenantId, fabricId, name: "White" });
    rollId = (
      await new PostgresRollRepository(db).create(
        {
          colorId,
          rollNo: `R-${randomUUID().slice(0, 8)}`,
          initialKg: 20,
          remainingKg: 20,
          pieces: 2,
          pricePerKg: 4,
          currency: "USD",
          entryDate: "2025-01-01",
        },
        ctx,
      )
    ).id;
    invoiceId = (
      await invoiceRepo.create(
        {
          type: "sale",
          date: "2025-06-01",
          partyId: customerId,
          partyType: "customer",
          currency: "USD",
          lines: [{ fabricId, colorId, rollId, quantityKg: 5, pieces: 1, pricePerKg: 10 }],
        } as never,
        ctx,
      )
    ).id;
    // The 2025 year is closed (as the year-closing flow leaves it).
    await db.insert(financialYears).values({
      tenantId,
      year: 2025,
      status: "closed",
      periodStart: "2025-01-01",
      periodEnd: "2025-12-31",
    } as never);
  });

  it("deleting a manual movement of a closed day is refused and the movement stays", async () => {
    const m = await cashbox.addManualMovement(
      {
        date: "2026-09-20",
        type: "capital",
        direction: "in",
        amount: 100,
        currency: "SYP",
      } as never,
      ctx,
    );
    await cashbox.closeDay({ date: "2026-09-20", counted: 100, currency: "SYP" } as never, ctx);
    await expect(cashbox.deleteManualMovement(m.id, ctx)).rejects.toThrow(/مغلق/);
    expect((await cashbox.listManualMovements(ctx)).some((x) => x.id === m.id)).toBe(true);
  });

  it("settling a balance inside the closed year is refused", async () => {
    await expect(
      new PostgresStatementRepository(db).settle(
        customerId,
        { date: "2025-12-31", currency: "USD", referenceNumber: "SET-1" },
        ctx,
      ),
    ).rejects.toThrow(/مغلق/);
  });

  it("a return dated in the closed year is refused", async () => {
    await expect(
      new PostgresReturnRepository(db).create(
        {
          kind: "sale",
          date: "2025-06-02",
          partyId: customerId,
          originalInvoiceId: invoiceId,
          reason: "defect",
          currency: "USD",
          lines: [{ rollId, quantityKg: 1, pieces: 1, pricePerKg: 10 }],
        },
        ctx,
      ),
    ).rejects.toThrow(/مغلق/);
  });

  it("cancelling an invoice of the closed year is refused and it stays active", async () => {
    const [inv] = await db
      .select({ version: invoices.version })
      .from(invoices)
      .where(eq(invoices.id, invoiceId));
    await expect(invoiceRepo.cancel(invoiceId, ctx.userId, ctx, inv!.version)).rejects.toThrow(
      /مغلق/,
    );
    const [after] = await db
      .select({ status: invoices.status })
      .from(invoices)
      .where(eq(invoices.id, invoiceId));
    expect(after!.status).toBe("active");
  });
});
