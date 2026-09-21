/**
 * Invoice numbering must be gapless and server-authoritative:
 *  - first entry invoice ENT-<year>-0001, the second ENT-<year>-0002 (never 0602);
 *  - a failed save, a preview (peek) or an edit/cancel never burns a number;
 *  - concurrent saves get distinct consecutive numbers;
 *  - offline number blocks are off by default (they jump the shared counter).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/infrastructure/orm/drizzle.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import { parties } from "@/infrastructure/orm/schemas/party.table.js";
import { fabrics } from "@/infrastructure/orm/schemas/fabric.table.js";
import { colors } from "@/infrastructure/orm/schemas/color.table.js";
import { PostgresRollRepository } from "@/infrastructure/repositories/PostgresRollRepository.js";
import { PostgresInvoiceRepository } from "@/infrastructure/repositories/PostgresInvoiceRepository.js";
import {
  allocateDocumentNumber,
  numberBlocksEnabled,
  peekNextDocumentNumber,
} from "@/infrastructure/utils/documentNumbers.js";
import { claimNumberBlock } from "@/application/use-cases/sync/numberBlockUseCases.js";
import { BusinessRuleError } from "@/domain/errors/index.js";
import type { TenantContext } from "@/domain/types/index.js";

let reachable = false;
const tenantId = randomUUID();
const supplierId = randomUUID();
const customerId = randomUUID();
const fabricId = randomUUID();
const colorId = randomUUID();
const year = new Date().getFullYear();
const ctx: TenantContext = {
  tenantId,
  userId: randomUUID(),
  userRole: "admin",
  userName: "numbering-tester",
};

const newRoll = async () =>
  new PostgresRollRepository(db).create(
    {
      colorId,
      rollNo: `R-${randomUUID().slice(0, 8)}`,
      initialKg: 10,
      remainingKg: 0,
      pieces: 1,
      pricePerKg: 5,
      currency: "USD",
      supplierId,
      entryDate: "2026-01-10",
    },
    ctx,
  );

const entryInput = async (
  partyId = supplierId,
  partyType: "supplier" | "customer" = "supplier",
) => {
  const roll = await newRoll();
  return {
    type: "entry" as const,
    date: "2026-01-10",
    partyId,
    partyType,
    currency: "USD" as const,
    exchangeRate: 1,
    lines: [{ fabricId, colorId, rollId: roll.id, quantityKg: 10, pieces: 1, pricePerKg: 5 }],
  };
};

describe("gapless invoice numbering", () => {
  beforeAll(async () => {
    try {
      await db.execute(sql`select 1`);
      reachable = true;
      await db.insert(tenants).values({
        id: tenantId,
        name: "Numbering Tenant",
        slug: `num-${tenantId.slice(0, 8)}`,
      });
      await db.insert(parties).values([
        { id: supplierId, tenantId, name: "Sup", code: "S1", kind: "supplier", currency: "USD" },
        { id: customerId, tenantId, name: "Cust", code: "C1", kind: "customer", currency: "USD" },
      ]);
      await db.insert(fabrics).values({ id: fabricId, tenantId, name: "Cotton", minStockKg: "0" });
      await db.insert(colors).values({ id: colorId, tenantId, fabricId, name: "White" });
    } catch {
      reachable = false;
    }
  });

  it("offline number blocks are disabled by default", async () => {
    expect(numberBlocksEnabled()).toBe(false);
    await expect(
      claimNumberBlock({ tenantId, syncDeviceId: randomUUID(), entityType: "invoice_entry" }),
    ).rejects.toBeInstanceOf(BusinessRuleError);
  });

  it("issues ENT-0001, ENT-0002 in order; preview and failed saves consume nothing", async () => {
    if (!reachable) return;
    const repo = new PostgresInvoiceRepository(db);

    // Opening the screen (peek) many times must not move the counter.
    for (let i = 0; i < 3; i++) await peekNextDocumentNumber("invoice_entry", tenantId);
    expect(await peekNextDocumentNumber("invoice_entry", tenantId)).toBe(`ENT-${year}-0001`);

    const first = await repo.create(await entryInput(), ctx);
    expect(first.number).toBe(`ENT-${year}-0001`);

    // Failed saves (entry invoice against a customer) roll the allocation back.
    for (let i = 0; i < 3; i++) {
      await expect(repo.create(await entryInput(customerId, "supplier"), ctx)).rejects.toBeInstanceOf(
        BusinessRuleError,
      );
    }
    expect(await peekNextDocumentNumber("invoice_entry", tenantId)).toBe(`ENT-${year}-0002`);

    const second = await repo.create(await entryInput(), ctx);
    expect(second.number).toBe(`ENT-${year}-0002`);

    // Cancelling an invoice never allocates a number.
    await repo.cancel(second.id, ctx.userId, ctx, second.version ?? 1);
    expect(await peekNextDocumentNumber("invoice_entry", tenantId)).toBe(`ENT-${year}-0003`);
  });

  it("concurrent allocations are distinct and consecutive; a rolled-back tx frees its number", async () => {
    if (!reachable) return;
    const nums = await Promise.all(
      Array.from({ length: 8 }, () =>
        db.transaction((tx) => allocateDocumentNumber(tx, "voucher", tenantId)),
      ),
    );
    const n = nums.map((s) => Number(s.split("-")[2])).sort((a, b) => a - b);
    expect(new Set(nums).size).toBe(8);
    expect(n).toEqual(Array.from({ length: 8 }, (_, i) => i + 1));

    await expect(
      db.transaction(async (tx) => {
        await allocateDocumentNumber(tx, "voucher", tenantId);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect(await peekNextDocumentNumber("voucher", tenantId)).toBe(`VOC-${year}-0009`);
  });
});
