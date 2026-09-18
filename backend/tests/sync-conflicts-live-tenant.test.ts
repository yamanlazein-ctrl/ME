/**
 * DFP-019 — live pool path: recordSyncConflict / listSyncConflicts refuse
 * missing or mismatched ambient tenant context before touching Postgres.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/infrastructure/orm/drizzle.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import {
  listSyncConflicts,
  recordSyncConflict,
} from "@/application/use-cases/sync/syncConflicts.js";
import { runWithTenantContext, runWithPlatformContext } from "@/infrastructure/orm/tenant-context.js";

const LIVE = Boolean(process.env.DATABASE_URL || process.env.TEST_DB_URL);

describe.skipIf(!LIVE)("DFP-019 syncConflicts live tenant guard", () => {
  const tenantA = randomUUID();
  const tenantB = randomUUID();

  beforeAll(async () => {
    await db.execute(sql`SELECT 1`);
    await runWithPlatformContext(async () => {
      await db.insert(tenants).values([
        { id: tenantA, name: "DFP019 A", slug: `dfp019-a-${tenantA.slice(0, 8)}` },
        { id: tenantB, name: "DFP019 B", slug: `dfp019-b-${tenantB.slice(0, 8)}` },
      ]);
    });
  });

  it("refuses recordSyncConflict with no ALS/ambient tenant", async () => {
    await expect(
      recordSyncConflict({
        tenantId: tenantA,
        opId: randomUUID(),
        entityType: "invoice",
        entityId: randomUUID(),
        operation: "update",
        baseVersion: 1,
        serverVersion: 2,
        localIntent: { x: 1 },
      }),
    ).rejects.toThrow(/without tenant context/);
  });

  it("refuses listSyncConflicts under mismatched ALS tenant", async () => {
    await runWithTenantContext({ tenantId: tenantB }, async () => {
      await expect(listSyncConflicts(tenantA, { openOnly: true })).rejects.toThrow(
        /tenant mismatch/,
      );
    });
  });

  it("records and lists under matching ALS tenant", async () => {
    const opId = randomUUID();
    const entityId = randomUUID();
    await runWithTenantContext({ tenantId: tenantA }, async () => {
      const wrote = await recordSyncConflict({
        tenantId: tenantA,
        opId,
        entityType: "invoice",
        entityId,
        operation: "update",
        baseVersion: 1,
        serverVersion: 2,
        localIntent: { note: "dfp019" },
      });
      expect(wrote).toBe(true);
      const rows = await listSyncConflicts(tenantA, { openOnly: true });
      expect(rows.some((r) => r.opId === opId)).toBe(true);
    });
  });
});
