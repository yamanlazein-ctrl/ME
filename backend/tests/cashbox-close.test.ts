import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/infrastructure/orm/drizzle.js";
import {
  cashboxSessions,
  manualMovements,
} from "@/infrastructure/orm/schemas/cashbox.table.js";
import { ledgerEntries } from "@/infrastructure/orm/schemas/ledger-entry.table.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import { parties } from "@/infrastructure/orm/schemas/party.table.js";
import { PostgresCashboxRepository } from "@/infrastructure/repositories/PostgresCashboxRepository.js";
import { randomUUID } from "node:crypto";

/**
 * P0-LOGIC regression: the cash day-close used to trust client-supplied
 * openingBalance/totalIn/totalOut, so a cashier 500,000 short could post an
 * inflated totalOut and store a difference of 0 (an attacker-chosen control
 * record). The close must recompute those figures from the ledger.
 */
describe("cashbox day close derives figures server-side", () => {
  const tenantId = randomUUID();
  const partyId = randomUUID();
  const repo = new PostgresCashboxRepository(db);

  beforeAll(async () => {
    await db
      .insert(tenants)
      .values({ id: tenantId, name: "CB", slug: `cb-${tenantId.slice(0, 8)}` });
    await db.insert(parties).values({
      id: partyId,
      tenantId,
      name: "Cash Party",
      code: "CASH",
      kind: "customer",
      currency: "SYP",
    });
    await db.insert(cashboxSessions).values({
      tenantId,
      openingBalance: 1000,
      openingDate: "2026-01-01",
      currency: "SYP",
    });
    await db.insert(manualMovements).values({
      tenantId,
      date: "2026-01-01",
      type: "capital",
      direction: "in",
      amount: 300,
      currency: "SYP",
    });
    await db.insert(ledgerEntries).values({
      tenantId,
      partyId,
      date: "2026-01-01",
      type: "cash",
      debit: 700,
      credit: 0,
      currency: "SYP",
      cashImpact: "in",
      referenceType: "receipt_in",
      referenceId: randomUUID(),
      createdBy: randomUUID(),
    });
  });

  it("derives totals from the ledger, not the request", async () => {
    const ctx = { tenantId, userId: randomUUID() };
    const closing = await repo.closeDay(
      { date: "2026-01-01", counted: 1500, currency: "SYP" },
      ctx,
    );
    // opening 1000 + (700 ledger-in + 300 manual-in) = 2000 expected; out = 0.
    expect(closing.openingBalance).toBe(1000);
    expect(closing.totalIn).toBe(1000);
    expect(closing.totalOut).toBe(0);
    expect(closing.expected).toBe(2000);
    expect(closing.difference).toBe(-500);
  });
});