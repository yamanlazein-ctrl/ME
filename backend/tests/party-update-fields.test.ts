/**
 * Regression: PostgresPartyRepository.update() used to whitelist only
 * {name, code, phone, mobile, email, address, city, country, notes} in its
 * SET clause — every other editable field the party form sends
 * (companyName, commercialReg, category, salesRep, whatsapp, altPhone,
 * website, taxNumber, currency, paymentTerms, paymentMethod,
 * defaultDiscount, vat) was silently dropped: the API returned 200, the
 * response echoed the values back (toDomain reads every column), but the
 * row on disk never changed — so a reload/restart reverted the edit with
 * no error ever surfaced to the user.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "@/infrastructure/orm/drizzle.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import { parties } from "@/infrastructure/orm/schemas/party.table.js";
import { PostgresPartyRepository } from "@/infrastructure/repositories/PostgresPartyRepository.js";
import type { TenantContext } from "@/domain/types/index.js";

let reachable = false;
const tenantId = randomUUID();
const ctx: TenantContext = {
  tenantId,
  userId: randomUUID(),
  userRole: "admin",
  userName: "party-update-tester",
};

describe("PostgresPartyRepository.update — every editable field persists", () => {
  beforeAll(async () => {
    try {
      await db.execute(sql`select 1`);
      reachable = true;
      await db
        .insert(tenants)
        .values({ id: tenantId, name: "Party Update Tenant", slug: `pu-${tenantId.slice(0, 8)}` });
    } catch {
      reachable = false;
    }
  });

  it("persists name plus every other whitelisted field, verified by a fresh read", async () => {
    if (!reachable) return;
    const repo = new PostgresPartyRepository(db);
    const created = await repo.create(
      {
        kind: "customer",
        name: "قبل التعديل",
        currency: "SYP",
      } as never,
      ctx,
    );

    const updated = await repo.update(
      created.id,
      {
        name: "بعد التعديل",
        companyName: "شركة الشام",
        commercialReg: "CR-1001",
        category: "قماش",
        salesRep: "أحمد",
        whatsapp: "0999111222",
        altPhone: "011222333",
        website: "https://example.com",
        taxNumber: "TAX-99",
        currency: "USD",
        paymentTerms: "net30",
        paymentMethod: "transfer",
        defaultDiscount: 5,
        vat: 0.11,
        notes: "ملاحظة اختبار",
      },
      ctx,
      created.version,
    );

    // The write path's own return value.
    expect(updated.name).toBe("بعد التعديل");
    expect(updated.companyName).toBe("شركة الشام");
    expect(updated.currency).toBe("USD");
    expect(updated.defaultDiscount).toBe(5);

    // Independent fresh read — simulates reload/restart, proves the row on
    // disk actually changed and this isn't just an echoed response.
    const reread = await repo.findById(created.id, ctx);
    expect(reread?.name).toBe("بعد التعديل");
    expect(reread?.companyName).toBe("شركة الشام");
    expect(reread?.commercialReg).toBe("CR-1001");
    expect(reread?.category).toBe("قماش");
    expect(reread?.salesRep).toBe("أحمد");
    expect(reread?.whatsapp).toBe("0999111222");
    expect(reread?.altPhone).toBe("011222333");
    expect(reread?.website).toBe("https://example.com");
    expect(reread?.taxNumber).toBe("TAX-99");
    expect(reread?.currency).toBe("USD");
    expect(reread?.paymentTerms).toBe("net30");
    expect(reread?.paymentMethod).toBe("transfer");
    expect(reread?.defaultDiscount).toBe(5);
    expect(reread?.vat).toBeCloseTo(0.11);
    expect(reread?.notes).toBe("ملاحظة اختبار");
  });

  it("still refuses to change openingBalance after creation", async () => {
    if (!reachable) return;
    const repo = new PostgresPartyRepository(db);
    const created = await repo.create(
      { kind: "customer", name: "عميل رصيد افتتاحي", openingBalance: 100 } as never,
      ctx,
    );
    await expect(
      repo.update(created.id, { openingBalance: 500 }, ctx, created.version),
    ).rejects.toThrow(/الرصيد الافتتاحي/);
  });
});
