/**
 * Live verification of F-08 — resource claims were never released.
 *
 * Symptom this guards (found by the sync audit 2026-09-10): an invoice create
 * claims `roll:<id>` for every roll it consumes, but NOTHING ever released
 * those claims. Once an invoice was cancelled, its rolls stayed reserved
 * forever and every later sale of them from ANY device was rejected as a
 * first-write-wins conflict — permanent, silent degradation of the stock the
 * business can sell.
 *
 * This is a REAL database test: it runs the actual
 * `PostgresSyncResourceClaimRepository` against PostgreSQL (RLS included), not
 * a mock. It is skipped automatically when no test database is reachable so it
 * cannot break an offline `vitest run`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/infrastructure/orm/drizzle.js";
import { runWithTenantContext, runWithPlatformContext } from "@/infrastructure/orm/tenant-context.js";
import { PostgresSyncResourceClaimRepository } from "@/infrastructure/repositories/PostgresSyncResourceClaimRepository.js";

let reachable = false;
let tenantId = "";

async function canConnect(): Promise<boolean> {
  try {
    await db.execute(sql`select 1`);
    return true;
  } catch {
    return false;
  }
}

async function seedTenant(): Promise<void> {
  await runWithPlatformContext(async () => {
    await db.execute(sql`
      insert into tenants (id, name, slug, status, license_status, license_type)
      values (${tenantId}, 'F-08 Claim Release Tenant', ${`f08-${tenantId.slice(0, 8)}`},
              'active', 'no_license', 'trial')
      on conflict (id) do nothing
    `);
  });
}

async function insertClaim(input: {
  resourceType: string;
  resourceId: string;
  entityType: string;
  entityId: string;
}): Promise<void> {
  await runWithTenantContext({ tenantId }, async () => {
    await db.execute(sql`
      insert into sync_resource_claims
        (tenant_id, resource_type, resource_id, claimed_by_op_id, claimed_by_device_id,
         entity_type, entity_id)
      values (${tenantId}, ${input.resourceType}, ${input.resourceId}, ${randomUUID()}, null,
              ${input.entityType}, ${input.entityId})
      on conflict do nothing
    `);
  });
}

async function countClaims(entityType: string, entityId: string): Promise<number> {
  return runWithTenantContext({ tenantId }, async () => {
    const res = await db.execute<{ c: number }>(sql`
      select count(*)::int as c from sync_resource_claims
       where tenant_id = ${tenantId}
         and entity_type = ${entityType}
         and entity_id = ${entityId}
    `);
    return Number((res.rows?.[0] as { c: number } | undefined)?.c ?? 0);
  });
}

describe("F-08 — releasing resource claims when a document is cancelled", () => {
  const cancelledInvoice = randomUUID();
  const otherInvoice = randomUUID();
  const rollA = randomUUID();
  const rollB = randomUUID();
  const rollC = randomUUID();

  beforeAll(async () => {
    reachable = await canConnect();
    if (!reachable) return;
    tenantId = randomUUID();
    await seedTenant();
    // The cancelled invoice holds two rolls.
    await insertClaim({ resourceType: "roll", resourceId: rollA, entityType: "invoice", entityId: cancelledInvoice });
    await insertClaim({ resourceType: "roll", resourceId: rollB, entityType: "invoice", entityId: cancelledInvoice });
    // An unrelated invoice holds a third roll and must NOT be touched.
    await insertClaim({ resourceType: "roll", resourceId: rollC, entityType: "invoice", entityId: otherInvoice });
  });

  afterAll(async () => {
    if (!reachable) return;
    await runWithPlatformContext(async () => {
      await db.execute(sql`delete from sync_resource_claims where tenant_id = ${tenantId}`);
      await db.execute(sql`delete from tenants where id = ${tenantId}`);
    });
  });

  it("releases exactly the cancelled document's claims", async () => {
    if (!reachable) return; // no database in this environment — see note above

    expect(await countClaims("invoice", cancelledInvoice)).toBe(2);
    expect(await countClaims("invoice", otherInvoice)).toBe(1);

    const repo = new PostgresSyncResourceClaimRepository(db);
    const released = await repo.releaseByEntity(tenantId, "invoice", cancelledInvoice, [
      "roll",
      "invoice_update_roll",
      "return_roll",
    ]);

    expect(released, "both roll claims of the cancelled invoice must be released").toBe(2);
    expect(await countClaims("invoice", cancelledInvoice)).toBe(0);
    expect(
      await countClaims("invoice", otherInvoice),
      "an unrelated invoice's claims must survive the release",
    ).toBe(1);
  });

  it("respects the resourceTypes filter", async () => {
    if (!reachable) return;

    const invoiceId = randomUUID();
    const rollId = randomUUID();
    await insertClaim({ resourceType: "roll", resourceId: rollId, entityType: "invoice", entityId: invoiceId });
    await insertClaim({ resourceType: "invoice_cancel", resourceId: invoiceId, entityType: "invoice", entityId: invoiceId });

    const repo = new PostgresSyncResourceClaimRepository(db);
    const released = await repo.releaseByEntity(tenantId, "invoice", invoiceId, ["roll"]);

    expect(released, "only the roll claim should be released").toBe(1);
    // The cancel guard claim is deliberately left in place.
    expect(await countClaims("invoice", invoiceId)).toBe(1);
  });

  it("is a no-op for a document that holds no claims", async () => {
    if (!reachable) return;
    const repo = new PostgresSyncResourceClaimRepository(db);
    const released = await repo.releaseByEntity(tenantId, "invoice", randomUUID(), ["roll"]);
    expect(released).toBe(0);
  });
});
