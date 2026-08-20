import { describe, it, expect, beforeAll } from "vitest";
import { db } from "@/infrastructure/orm/drizzle.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import { users } from "@/infrastructure/orm/schemas/user.table.js";
import { PostgresInvitationRepository } from "@/infrastructure/repositories/PostgresInvitationRepository.js";
import { randomUUID } from "node:crypto";

/**
 * P1-SEC regression: revoke(id) filtered by id only, so any tenant admin could
 * revoke another tenant's pending invitation. revoke must be tenant-scoped.
 */
describe("invitation revoke is tenant-scoped", () => {
  const tenantA = randomUUID();
  const tenantB = randomUUID();
  const repo = new PostgresInvitationRepository(db);
  let invitationId: string;
  let code: string;

  beforeAll(async () => {
    await db.insert(tenants).values([
      { id: tenantA, name: "Tenant A", slug: `a-${tenantA.slice(0, 6)}` },
      { id: tenantB, name: "Tenant B", slug: `b-${tenantB.slice(0, 6)}` },
    ]);
    const [userB] = await db
      .insert(users)
      .values({
        tenantId: tenantB,
        name: "B Admin",
        email: `b-admin-${tenantB.slice(0, 6)}@test.local`,
        passwordHash: "x",
        role: "admin",
      })
      .returning({ id: users.id });
    code = `INV-${randomUUID().slice(0, 8).toUpperCase()}`;
    const created = await repo.create({
      tenantId: tenantB,
      code,
      type: "user",
      expiresAt: new Date(Date.now() + 3600_000),
      createdBy: userB.id,
    });
    invitationId = created.id;
  });

  it("tenant A cannot revoke tenant B's invitation", async () => {
    const revoked = await repo.revoke(invitationId, tenantA);
    expect(revoked).toBe(false);
    const row = await repo.findByCode(code);
    expect(row?.revokedAt).toBeNull();
  });

  it("tenant B can revoke its own invitation", async () => {
    const revoked = await repo.revoke(invitationId, tenantB);
    expect(revoked).toBe(true);
    const row = await repo.findByCode(code);
    expect(row?.revokedAt).not.toBeNull();
  });
});