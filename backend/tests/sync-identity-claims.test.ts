/**
 * Identity FWW must only block concurrent (unapplied) holders.
 * After apply, a later settlement / party update on the same resource is allowed.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/infrastructure/orm/drizzle.js";
import { runWithTenantContext, runWithPlatformContext } from "@/infrastructure/orm/tenant-context.js";
import { PostgresSyncResourceClaimRepository } from "@/infrastructure/repositories/PostgresSyncResourceClaimRepository.js";
import { databaseReachable } from "./_helpers/requireDatabase.js";

let reachable = false;
let tenantId = "";

// FIN-09: an unreachable database is a hard failure when DATABASE_URL is set,
// so this suite can no longer pass without exercising its assertions.
const canConnect = databaseReachable;

describe("identity claims — applied holders do not lock forever", () => {
  beforeAll(async () => {
    reachable = await canConnect();
    if (!reachable) return;
    tenantId = randomUUID();
    await runWithPlatformContext(async () => {
      await db.execute(sql`
        insert into tenants (id, name, slug, status, license_status, license_type)
        values (${tenantId}, 'Identity Claim Tenant', ${`idc-${tenantId.slice(0, 8)}`},
                'active', 'no_license', 'trial')
        on conflict (id) do nothing
      `);
    });
  });

  afterAll(async () => {
    if (!reachable) return;
    await runWithPlatformContext(async () => {
      await db.execute(sql`delete from sync_resource_claims where tenant_id = ${tenantId}`);
      await db.execute(sql`delete from sync_inbox where tenant_id = ${tenantId}`);
      await db.execute(sql`delete from tenants where id = ${tenantId}`);
    });
  });

  it("second identity claim succeeds after the first holder is applied", async () => {
    if (!reachable) return;
    const partyId = randomUUID();
    const op1 = randomUUID();
    const op2 = randomUUID();
    const claims = new PostgresSyncResourceClaimRepository(db);

    await runWithTenantContext({ tenantId }, async () => {
      await db.execute(sql`
        insert into sync_inbox
          (tenant_id, op_id, entity_type, entity_id, operation, payload, status, applied_at)
        values (${tenantId}, ${op1}, 'settlement', ${partyId}, 'create', '{}'::jsonb, 'applied', now())
      `);
      await db.execute(sql`
        insert into sync_resource_claims
          (tenant_id, resource_type, resource_id, claimed_by_op_id, entity_type, entity_id)
        values (${tenantId}, 'party', ${partyId}, ${op1}, 'settlement', ${partyId})
      `);
      const first = await claims.tryClaimAll({
        tenantId,
        opId: op2,
        entityType: "settlement",
        entityId: partyId,
        resources: [{ resourceType: "party", resourceId: partyId }],
      });
      expect(first.ok, JSON.stringify(first)).toBe(true);
    });
  });

  it("two received holders on the same identity still 409", async () => {
    if (!reachable) return;
    const partyId = randomUUID();
    const op1 = randomUUID();
    const op2 = randomUUID();
    const claims = new PostgresSyncResourceClaimRepository(db);

    await runWithTenantContext({ tenantId }, async () => {
      await db.execute(sql`
        insert into sync_inbox
          (tenant_id, op_id, entity_type, entity_id, operation, payload, status)
        values (${tenantId}, ${op1}, 'party', ${partyId}, 'update', '{}'::jsonb, 'received')
      `);
      await db.execute(sql`
        insert into sync_resource_claims
          (tenant_id, resource_type, resource_id, claimed_by_op_id, entity_type, entity_id)
        values (${tenantId}, 'party', ${partyId}, ${op1}, 'party', ${partyId})
      `);
      const second = await claims.tryClaimAll({
        tenantId,
        opId: op2,
        entityType: "party",
        entityId: partyId,
        resources: [{ resourceType: "party", resourceId: partyId }],
      });
      expect(second.ok).toBe(false);
    });
  });
});
