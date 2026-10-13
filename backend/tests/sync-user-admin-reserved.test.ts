/**
 * VERIFIED_REMEDIATION_PLAN NEW-01 + ERP-001 (sync path) — on the hub, a user unit pushed under a
 * non-admin session must not grant the admin role nor change an admin account (the transport admits
 * accountants); an applied snapshot must take effect at once (identity cache invalidated).
 * Canonical hub data (pull path, hubCanonical) stays trusted. Engine-agnostic (SQLite + PG).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "@/infrastructure/orm/drizzle.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import { users } from "@/infrastructure/orm/schemas/user.table.js";
import { materializeSyncUnit } from "@/application/use-cases/sync/syncMaterialize.js";
import { resolveSessionIdentity } from "@/infrastructure/auth/sessionCutoff.js";
import type { TenantContext } from "@/domain/types/index.js";

const tenantId = randomUUID();
const adminId = randomUUID();
const clerkId = randomUUID();
const ctx = (userRole: TenantContext["userRole"]): TenantContext => ({
  tenantId,
  userId: randomUUID(),
  userRole,
  userName: "new01",
});
const snapshot = (id: string, role: string, name: string, at: string) => ({
  snapshot: {
    id,
    email: `${id.slice(0, 8)}@x.io`,
    name,
    role,
    passwordHash: "h:forged",
    active: true,
    updatedAt: at,
  },
});
const unit = (payload: Record<string, unknown>) => ({
  entityType: "user",
  operation: "update",
  payload,
});
const roleOf = async (id: string) =>
  (
    await db
      .select({ role: users.role, hash: users.passwordHash })
      .from(users)
      .where(and(eq(users.id, id), eq(users.tenantId, tenantId)))
  )[0];

describe("hub user units: the admin role stays with admins", () => {
  beforeAll(async () => {
    await db.execute(sql`select 1`);
    await db
      .insert(tenants)
      .values({ id: tenantId, name: "N1", slug: `n1-${tenantId.slice(0, 8)}` });
    const base = { tenantId, passwordHash: "h:orig", updatedAt: new Date("2026-01-01T00:00:00Z") };
    await db.insert(users).values([
      { ...base, id: adminId, name: "A", email: `${adminId.slice(0, 8)}@x.io`, role: "admin" },
      { ...base, id: clerkId, name: "C", email: `${clerkId.slice(0, 8)}@x.io`, role: "warehouse" },
    ]);
  });

  it("an accountant push cannot grant admin nor rewrite an admin account", async () => {
    const at = "2026-10-01T00:00:00.000Z";
    const grant = await materializeSyncUnit(
      db as never,
      {} as never,
      unit(snapshot(clerkId, "admin", "C", at)),
      ctx("accountant"),
    );
    expect(grant.status).toBe("invalid");
    const takeover = await materializeSyncUnit(
      db as never,
      {} as never,
      unit(snapshot(adminId, "admin", "A", at)),
      ctx("accountant"),
    );
    expect(takeover.status).toBe("invalid");
    expect(await roleOf(clerkId)).toEqual({ role: "warehouse", hash: "h:orig" });
    expect(await roleOf(adminId)).toEqual({ role: "admin", hash: "h:orig" });
  });

  it("an accountant push still manages non-admin users, effective at once", async () => {
    expect((await resolveSessionIdentity(clerkId, "C")).role).toBe("warehouse"); // warm the cache
    const r = await materializeSyncUnit(
      db as never,
      {} as never,
      unit(snapshot(clerkId, "viewer", "C", "2026-10-02T00:00:00.000Z")),
      ctx("accountant"),
    );
    expect(r.status).toBe("created");
    expect((await resolveSessionIdentity(clerkId, "C")).role).toBe("viewer");
  });

  it("an admin push, and canonical hub data on pull, may grant admin", async () => {
    const r = await materializeSyncUnit(
      db as never,
      {} as never,
      unit(snapshot(clerkId, "admin", "C", "2026-10-03T00:00:00.000Z")),
      ctx("admin"),
    );
    expect(r.status).toBe("created");
    const pulled = await materializeSyncUnit(
      db as never,
      {} as never,
      unit(snapshot(adminId, "accountant", "A", "2026-10-04T00:00:00.000Z")),
      ctx("accountant"),
      { hubCanonical: true },
    );
    expect(pulled.status).toBe("created");
    expect((await roleOf(clerkId))?.role).toBe("admin");
    expect((await roleOf(adminId))?.role).toBe("accountant");
  });
});
