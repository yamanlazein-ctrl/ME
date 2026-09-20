/**
 * Behavioral: first-write-wins stock claims on the hub.
 *
 * Two concurrent (unapplied) holders on the same roll: first claim wins,
 * second is refused. Same op retry is idempotent.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/infrastructure/orm/drizzle.js";
import { runWithTenantContext, runWithPlatformContext } from "@/infrastructure/orm/tenant-context.js";
import { PostgresSyncResourceClaimRepository } from "@/infrastructure/repositories/PostgresSyncResourceClaimRepository.js";
import { databaseReachable, skipUnlessDatabase } from "./_helpers/requireDatabase.js";

let reachable = false;
let tenantId = "";

describe("sync behavioral — first-write-wins stock claims", () => {
  beforeAll(async () => {
    reachable = await databaseReachable();
    if (!reachable) return;
    tenantId = randomUUID();
    await runWithPlatformContext(async () => {
      await db.execute(sql`
        insert into tenants (id, name, slug, status, license_status, license_type)
        values (${tenantId}, 'Sync Claims FWW Tenant', ${`scf-${tenantId.slice(0, 8)}`},
                'active', 'no_license', 'trial')
        on conflict (id) do nothing
      `);
    });
  });

  afterAll(async () => {
    if (!reachable || !tenantId) return;
    await runWithPlatformContext(async () => {
      await db.execute(sql`delete from sync_resource_claims where tenant_id = ${tenantId}`);
      await db.execute(sql`delete from sync_inbox where tenant_id = ${tenantId}`);
      await db.execute(sql`delete from tenants where id = ${tenantId}`);
    });
  });

  it("second concurrent whole-roll claim loses; same-op retry is a no-op win", async (ctx) => {
    skipUnlessDatabase(reachable, ctx.skip);
    const claims = new PostgresSyncResourceClaimRepository(db);
    const rollId = randomUUID();
    const invoiceA = randomUUID();
    const invoiceB = randomUUID();
    const op1 = randomUUID();
    const op2 = randomUUID();

    await runWithTenantContext({ tenantId }, async () => {
      await db.execute(sql`
        insert into sync_inbox
          (tenant_id, op_id, entity_type, entity_id, operation, payload, status)
        values
          (${tenantId}, ${op1}, 'invoice', ${invoiceA}, 'create', '{}'::jsonb, 'received'),
          (${tenantId}, ${op2}, 'invoice', ${invoiceB}, 'create', '{}'::jsonb, 'received')
      `);
    });

    const first = await claims.tryClaimAll({
      tenantId,
      opId: op1,
      entityType: "invoice",
      entityId: invoiceA,
      resources: [{ resourceType: "roll", resourceId: rollId }],
    });
    expect(first.ok, JSON.stringify(first)).toBe(true);

    const retry = await claims.tryClaimAll({
      tenantId,
      opId: op1,
      entityType: "invoice",
      entityId: invoiceA,
      resources: [{ resourceType: "roll", resourceId: rollId }],
    });
    expect(retry.ok, "same op must re-enter idempotently").toBe(true);

    const second = await claims.tryClaimAll({
      tenantId,
      opId: op2,
      entityType: "invoice",
      entityId: invoiceB,
      resources: [{ resourceType: "roll", resourceId: rollId }],
    });
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.conflicts[0]?.claimedByOpId).toBe(op1);
      expect(second.conflicts[0]?.resourceId).toBe(rollId);
    }
  });
});
