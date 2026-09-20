/**
 * Behavioral: sync idempotency on (tenant_id, op_id).
 *
 * Replaces source-text guards like `.includes("ON CONFLICT (tenant_id, op_id)")`
 * with real Postgres inserts via inbox / outbox / conflict ledger.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/infrastructure/orm/drizzle.js";
import { runWithTenantContext, runWithPlatformContext } from "@/infrastructure/orm/tenant-context.js";
import { PostgresSyncInboxRepository } from "@/infrastructure/repositories/PostgresSyncInboxRepository.js";
import { PostgresSyncOutboxRepository } from "@/infrastructure/repositories/PostgresSyncOutboxRepository.js";
import { recordSyncConflict, listSyncConflicts } from "@/application/use-cases/sync/syncConflicts.js";
import { databaseReachable, skipUnlessDatabase } from "./_helpers/requireDatabase.js";

let reachable = false;
let tenantId = "";

describe("sync behavioral — idempotency on (tenant_id, op_id)", () => {
  beforeAll(async () => {
    reachable = await databaseReachable();
    if (!reachable) return;
    tenantId = randomUUID();
    await runWithPlatformContext(async () => {
      await db.execute(sql`
        insert into tenants (id, name, slug, status, license_status, license_type)
        values (${tenantId}, 'Sync Idempotency Tenant', ${`sid-${tenantId.slice(0, 8)}`},
                'active', 'no_license', 'trial')
        on conflict (id) do nothing
      `);
    });
  });

  afterAll(async () => {
    if (!reachable || !tenantId) return;
    await runWithPlatformContext(async () => {
      await db.execute(sql`delete from sync_conflicts where tenant_id = ${tenantId}`);
      await db.execute(sql`delete from sync_inbox where tenant_id = ${tenantId}`);
      await db.execute(sql`delete from sync_outbox where tenant_id = ${tenantId}`);
      await db.execute(sql`delete from tenants where id = ${tenantId}`);
    });
  });

  it("inbox receive is idempotent — second delivery returns the same row", async (ctx) => {
    skipUnlessDatabase(reachable, ctx.skip);
    const inbox = new PostgresSyncInboxRepository(db);
    const opId = randomUUID();
    const entityId = randomUUID();

    const first = await inbox.receive({
      tenantId,
      opId,
      entityType: "invoice",
      entityId,
      operation: "create",
      payload: { n: 1 },
    });
    expect(first.created).toBe(true);

    const second = await inbox.receive({
      tenantId,
      opId,
      entityType: "invoice",
      entityId,
      operation: "create",
      payload: { n: 2 },
    });
    expect(second.created).toBe(false);
    expect(second.row.id).toBe(first.row.id);
    expect(second.row.payload).toEqual({ n: 1 });

    await runWithTenantContext({ tenantId }, async () => {
      const count = await db.execute<{ c: number }>(sql`
        select count(*)::int as c from sync_inbox
         where tenant_id = ${tenantId} and op_id = ${opId}
      `);
      expect(Number((count.rows?.[0] as { c: number }).c)).toBe(1);
    });
  });

  it("outbox enqueue is idempotent — same op_id does not duplicate", async (ctx) => {
    skipUnlessDatabase(reachable, ctx.skip);
    const outbox = new PostgresSyncOutboxRepository(db);
    const opId = randomUUID();
    const entityId = randomUUID();

    const first = await outbox.enqueue({
      tenantId,
      opId,
      entityType: "voucher",
      entityId,
      operation: "create",
      payload: { a: 1 },
    });
    const second = await outbox.enqueue({
      tenantId,
      opId,
      entityType: "voucher",
      entityId,
      operation: "create",
      payload: { a: 2 },
    });
    expect(second.id).toBe(first.id);
    expect(second.payload).toEqual({ a: 1 });

    await runWithTenantContext({ tenantId }, async () => {
      const count = await db.execute<{ c: number }>(sql`
        select count(*)::int as c from sync_outbox
         where tenant_id = ${tenantId} and op_id = ${opId}
      `);
      expect(Number((count.rows?.[0] as { c: number }).c)).toBe(1);
    });
  });

  it("conflict recording is idempotent — first sighting wins", async (ctx) => {
    skipUnlessDatabase(reachable, ctx.skip);
    const opId = randomUUID();
    const entityId = randomUUID();

    await runWithTenantContext({ tenantId }, async () => {
      const wrote = await recordSyncConflict({
        tenantId,
        opId,
        entityType: "invoice",
        entityId,
        operation: "update",
        baseVersion: 1,
        serverVersion: 2,
        localIntent: { notes: "first" },
      });
      expect(wrote).toBe(true);

      const again = await recordSyncConflict({
        tenantId,
        opId,
        entityType: "invoice",
        entityId,
        operation: "update",
        baseVersion: 1,
        serverVersion: 99,
        localIntent: { notes: "retry-must-not-overwrite" },
      });
      expect(again).toBe(false);

      const rows = await listSyncConflicts(tenantId, { openOnly: true });
      const mine = rows.filter((r) => r.opId === opId);
      expect(mine).toHaveLength(1);
      expect(mine[0]?.localIntent?.notes).toBe("first");
      expect(mine[0]?.serverVersion).toBe(2);
    });
  });
});
