/**
 * VERIFIED_REMEDIATION_PLAN ERP-001 — a role change must reach the very next authorization check:
 * the session identity cache (60 s) used to be dropped only on deactivation, so a demoted admin kept
 * admin rights for up to a minute. Real engine repository (container) + real cache.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/infrastructure/orm/drizzle.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import { users } from "@/infrastructure/orm/schemas/user.table.js";
import { buildContainer } from "@/infrastructure/di/container.js";
import { resolveSessionIdentity } from "@/infrastructure/auth/sessionCutoff.js";
import type { TenantContext } from "@/domain/types/index.js";

const tenantId = randomUUID();
const userId = randomUUID();
const ctx: TenantContext = { tenantId, userId: randomUUID(), userRole: "admin", userName: "e1" };

describe("user role change → cached identity dropped", () => {
  beforeAll(async () => {
    await db.execute(sql`select 1`);
    await db
      .insert(tenants)
      .values({ id: tenantId, name: "E1", slug: `e1-${tenantId.slice(0, 8)}` });
    await db.insert(users).values({
      id: userId,
      tenantId,
      name: "Boss",
      email: `${userId.slice(0, 8)}@x.io`,
      passwordHash: "h",
      role: "admin",
    });
  });

  it("demotion and rename apply to the next resolve", async () => {
    expect((await resolveSessionIdentity(userId, "Boss")).role).toBe("admin"); // warm the cache
    await buildContainer().userRepo.update(userId, { role: "viewer", name: "Ex" }, ctx);
    const after = await resolveSessionIdentity(userId, "Boss");
    expect(after.role).toBe("viewer");
    expect(after.name).toBe("Ex");
  });
});
