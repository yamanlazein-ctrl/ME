/**
 * S-02 (PostgreSQL twin of sqlite/master-delete-tombstone-atomicity.test.ts): the F-03 fix wrapped the
 * master delete + tombstone in engine `runInTransaction`, which on PG is a bare `db.transaction()` that
 * publishes NO ambient transaction — the ambient-aware repositories and the tombstone store (raw pool)
 * each committed on their own connection. A failed tombstone left the row deleted with no tombstone.
 *
 * Live PostgreSQL only (skips visibly without DATABASE_URL — see _helpers/requireDatabase.ts).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db, ambientDb } from "@/infrastructure/orm/drizzle.js";
import { runWithTenantContext, runWithPlatformContext } from "@/infrastructure/orm/tenant-context.js";
import { PostgresFabricRepository } from "@/infrastructure/repositories/PostgresFabricRepository.js";
import { materializeSyncUnit } from "@/application/use-cases/sync/syncMaterialize.js";
import { databaseReachable, skipUnlessDatabase } from "./_helpers/requireDatabase.js";

let reachable = false;
const tenantId = randomUUID();
const ctx = { tenantId, userId: randomUUID(), userRole: "admin" } as never;

const seedFabric = async (): Promise<string> => {
  const id = randomUUID();
  await runWithTenantContext({ tenantId }, () =>
    db.execute(sql`insert into fabrics (id, tenant_id, name, min_stock_kg, version) values (${id}, ${tenantId}, ${`F-${id.slice(0, 6)}`}, 0, 1)`),
  );
  return id;
};
const exists = async (table: "fabrics" | "sync_tombstones", col: "id" | "entity_id", id: string) =>
  runWithPlatformContext(async () => (await db.execute(sql`select 1 from ${sql.raw(table)} where ${sql.raw(col)} = ${id}`)).rows.length > 0);
const deleteUnit = (id: string) =>
  runWithTenantContext({ tenantId }, () =>
    materializeSyncUnit(
      db,
      { fabricRepo: new PostgresFabricRepository(ambientDb(db)) } as never,
      { entityType: "fabric", operation: "delete", payload: { entityId: id, baseVersion: 1 } },
      ctx,
      { opId: randomUUID(), syncDeviceId: null },
    ),
  );

// PostgreSQL DDL (ALTER TABLE … ADD CONSTRAINT); the SQLite twin is sqlite/master-delete-tombstone-atomicity.
describe.skipIf(process.env.DB_ENGINE === "sqlite")("master delete + tombstone atomicity on PostgreSQL (S-02)", () => {
  beforeAll(async () => {
    reachable = await databaseReachable();
    if (!reachable) return;
    await runWithPlatformContext(() =>
      db.execute(sql`insert into tenants (id, name, slug, status, license_status, license_type)
                     values (${tenantId}, 'S02 Tenant', ${`s02-${tenantId.slice(0, 8)}`}, 'active', 'no_license', 'trial')`),
    );
  });

  afterAll(async () => {
    if (!reachable) return;
    await runWithPlatformContext(async () => {
      await db.execute(sql`delete from sync_tombstones where tenant_id = ${tenantId}`);
      await db.execute(sql`delete from fabrics where tenant_id = ${tenantId}`);
      await db.execute(sql`delete from tenants where id = ${tenantId}`);
    });
  });

  it("a delete at its base version commits WITH its tombstone", async (c) => {
    skipUnlessDatabase(reachable, c.skip);
    const id = await seedFabric();
    expect((await deleteUnit(id)).status).toBe("created");
    expect(await exists("fabrics", "id", id)).toBe(false);
    expect(await exists("sync_tombstones", "entity_id", id)).toBe(true);
  });

  it("a delete whose tombstone write fails ROLLS BACK — the row survives", async (c) => {
    skipUnlessDatabase(reachable, c.skip);
    const id = await seedFabric();
    // Refuse exactly this entity's tombstone (inline literal: DDL takes no bind parameters).
    const name = `s02_block_${id.slice(0, 8)}`;
    await db.execute(sql.raw(`alter table sync_tombstones add constraint ${name} check (entity_id::text <> '${id}') not valid`));
    try {
      expect((await deleteUnit(id)).status).not.toBe("created");
      expect(await exists("fabrics", "id", id), "delete must roll back with the failed tombstone").toBe(true);
    } finally {
      await db.execute(sql.raw(`alter table sync_tombstones drop constraint ${name}`));
    }
  });
});
