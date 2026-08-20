import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/infrastructure/orm/drizzle.js";
import { ledgerEntries } from "@/infrastructure/orm/schemas/ledger-entry.table.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import { parties } from "@/infrastructure/orm/schemas/party.table.js";
import { LEDGER_ENTRY_TYPES } from "@/domain/ledger-entry-type.js";
import { randomUUID } from "node:crypto";

describe("ledger_entries.type check constraint", () => {
  const tenantId = randomUUID();
  const partyId = randomUUID();

  beforeAll(async () => {
    await db.insert(tenants).values({ id: tenantId, name: "Test Tenant", slug: "test-tenant" });
    await db.insert(parties).values({
      id: partyId,
      tenantId,
      name: "Test Party",
      code: "TP",
      kind: "customer",
      currency: "SYP",
    });
  });

  it("accepts every ledger type the application writes", async () => {
    const date = "2026-01-01";
    for (const type of LEDGER_ENTRY_TYPES) {
      const row = {
        tenantId,
        partyId,
        date,
        type,
        debit: type.includes("_contra") ? 0 : 100,
        credit: type.includes("_contra") ? 100 : 0,
        currency: "SYP" as const,
        cashImpact: "none" as const,
        referenceType: type,
        referenceId: randomUUID(),
        description: `test ${type}`,
        createdBy: randomUUID(),
      };
      const result = await db.insert(ledgerEntries).values(row).returning();
      expect(result[0].type).toBe(type);
    }
  });

  it("rejects unknown ledger types", async () => {
    await expect(
      db.insert(ledgerEntries).values({
        tenantId,
        partyId,
        date: "2026-01-01",
        type: "unknown_type",
        debit: 0,
        credit: 100,
        currency: "SYP",
        cashImpact: "none",
        referenceType: "unknown",
        referenceId: randomUUID(),
        createdBy: randomUUID(),
      }),
    ).rejects.toThrow();
  });
});
