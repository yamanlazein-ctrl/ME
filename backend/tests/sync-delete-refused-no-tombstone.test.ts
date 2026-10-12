/**
 * CODEBASE_AUDIT_REPORT H-11 — a replayed master delete whose use case REFUSES (here: a party that
 * still has an active invoice) must not report success nor record a tombstone for a row that is
 * still active. Engine-agnostic (SQLite + PG).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { db } from "@/infrastructure/orm/drizzle.js";
import { ambientDb } from "@/infrastructure/orm/ambient-tx.js";
import { runWithTenantContext } from "@/infrastructure/orm/tenant-context.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import { parties } from "@/infrastructure/orm/schemas/party.table.js";
import { fabrics } from "@/infrastructure/orm/schemas/fabric.table.js";
import { colors } from "@/infrastructure/orm/schemas/color.table.js";
import { PostgresInvoiceRepository } from "@/infrastructure/repositories/PostgresInvoiceRepository.js";
import { PostgresRollRepository } from "@/infrastructure/repositories/PostgresRollRepository.js";
import { PostgresPartyRepository } from "@/infrastructure/repositories/PostgresPartyRepository.js";
import { materializeSyncUnit } from "@/application/use-cases/sync/syncMaterialize.js";
import type { TenantContext } from "@/domain/types/index.js";

const tenantId = randomUUID();
const customerId = randomUUID();
const fabricId = randomUUID();
const colorId = randomUUID();
const ctx: TenantContext = {
  tenantId,
  userId: randomUUID(),
  userRole: "admin",
  userName: "h11-tester",
};
const rows = (r: unknown) =>
  (Array.isArray(r) ? r : ((r as { rows?: unknown[] }).rows ?? [])) as unknown[];

describe("sync master delete: a refused delete leaves no tombstone", () => {
  beforeAll(async () => {
    await db.execute(sql`select 1`);
    await db
      .insert(tenants)
      .values({ id: tenantId, name: "H11", slug: `h11-${tenantId.slice(0, 8)}` });
    await db.insert(parties).values({
      id: customerId,
      tenantId,
      name: "C",
      code: "H11-C",
      kind: "customer",
      currency: "USD",
    });
    await db.insert(fabrics).values({ id: fabricId, tenantId, name: "Cotton", minStockKg: "0" });
    await db.insert(colors).values({ id: colorId, tenantId, fabricId, name: "White" });
    const roll = await new PostgresRollRepository(db).create(
      {
        colorId,
        rollNo: `R-${randomUUID().slice(0, 8)}`,
        initialKg: 10,
        remainingKg: 10,
        pieces: 1,
        pricePerKg: 4,
        currency: "USD",
        entryDate: "2026-09-01",
      },
      ctx,
    );
    await new PostgresInvoiceRepository(db).create(
      {
        type: "sale",
        date: "2026-09-10",
        partyId: customerId,
        partyType: "customer",
        currency: "USD",
        lines: [{ fabricId, colorId, rollId: roll.id, quantityKg: 1, pieces: 1, pricePerKg: 10 }],
      } as never,
      ctx,
    );
  });

  it("party with an active invoice: unit not 'created', party active, no tombstone", async () => {
    const [p] = await db
      .select({ version: parties.version })
      .from(parties)
      .where(eq(parties.id, customerId));
    const result = await runWithTenantContext({ tenantId }, () =>
      materializeSyncUnit(
        db as never,
        { partyRepo: new PostgresPartyRepository(ambientDb(db)) } as never,
        {
          entityType: "party",
          operation: "delete",
          payload: { entityId: customerId, baseVersion: p!.version },
        },
        ctx,
        { opId: randomUUID(), syncDeviceId: null },
      ),
    );
    expect(result.status).not.toBe("created");
    const [after] = await db
      .select({ status: parties.status })
      .from(parties)
      .where(eq(parties.id, customerId));
    expect(after!.status).toBe("active");
    expect(
      rows(await db.execute(sql`select 1 from sync_tombstones where entity_id = ${customerId}`)),
    ).toHaveLength(0);
  });
});
