import { eq, and } from "drizzle-orm";
import type { DB } from "../orm/drizzle.js";
import { runWithTenantContext } from "../orm/tenant-context.js";
import type { IAuthRepository } from "../../application/ports/IAuthRepository.js";
import { users } from "../orm/schemas/user.table.js";

/**
 * Auth repository — `users` is a category-1 (tenant-scoped) RLS table.
 *
 * RLS wiring (E-prep):
 * - `findUserByEmail(email, tenantId)` runs pre-JWT (login, setup wizard),
 *   so it stamps the tenant GUC itself from its explicit `tenantId`
 *   argument — never from the request.
 * - `findUserById(id)` is unscoped by signature; its callers (auth routes
 *   /me, /refresh) hold a VERIFIED JWT whose `payload.tenantId` supplies
 *   the GUC. Wrapping here would be wrong for tokens without a usable
 *   tenant (the super-admin "system" sentinel), so the ROUTE establishes
 *   the tenant context around the call.
 * - `createUser(input)` inserts a row owned by `input.tenantId` (setup
 *   wizard complete-step, pre-JWT), so it stamps the tenant GUC itself.
 *
 * No method trusts a client-supplied tenant id: callers pass ids that are
 * either explicit function parameters in bootstrap flows or verified-JWT
 * claims checked at the route layer.
 */
export class PostgresAuthRepository implements IAuthRepository {
  constructor(private readonly db: DB) {}

  async findUserByEmail(email: string, tenantId?: string) {
    if (!tenantId) throw new Error("tenantId is required for login");
    return runWithTenantContext({ tenantId }, async () => {
      const conditions = [eq(users.email, email), eq(users.tenantId, tenantId)];
      const rows = await this.db
        .select()
        .from(users)
        .where(and(...conditions))
        .limit(1);

      if (rows.length === 0) return null;
      const u = rows[0];
      return {
        id: u.id,
        tenantId: u.tenantId,
        name: u.name,
        email: u.email,
        passwordHash: u.passwordHash,
        pinHash: u.pinHash ?? null,
        role: u.role,
        active: u.active,
      };
    });
  }

  async findUserById(id: string) {
    const rows = await this.db.select().from(users).where(eq(users.id, id)).limit(1);

    if (rows.length === 0) return null;
    const u = rows[0];
    return {
      id: u.id,
      tenantId: u.tenantId,
      name: u.name,
      email: u.email,
      role: u.role,
      active: u.active,
      pinHash: u.pinHash ?? null,
    };
  }

  async findUserByIdForAuth(id: string, tenantId: string) {
    return runWithTenantContext({ tenantId }, async () => {
      const rows = await this.db
        .select()
        .from(users)
        .where(and(eq(users.id, id), eq(users.tenantId, tenantId)))
        .limit(1);
      if (rows.length === 0) return null;
      const u = rows[0];
      return {
        id: u.id,
        tenantId: u.tenantId,
        name: u.name,
        email: u.email,
        passwordHash: u.passwordHash,
        pinHash: u.pinHash ?? null,
        role: u.role,
        active: u.active,
      };
    });
  }

  async listActiveUsersForTenant(tenantId: string) {
    return runWithTenantContext({ tenantId }, async () => {
      const rows = await this.db
        .select({
          id: users.id,
          name: users.name,
          email: users.email,
          role: users.role,
          pinHash: users.pinHash,
        })
        .from(users)
        .where(and(eq(users.tenantId, tenantId), eq(users.active, true)));
      return rows.map((u) => ({
        id: u.id,
        name: u.name,
        email: u.email,
        role: u.role,
        hasPin: Boolean(u.pinHash),
      }));
    });
  }

  async setPinHash(userId: string, tenantId: string, pinHash: string) {
    await runWithTenantContext({ tenantId }, async () => {
      await this.db
        .update(users)
        .set({ pinHash, updatedAt: new Date() })
        .where(and(eq(users.id, userId), eq(users.tenantId, tenantId)));
    });
  }

  async createUser(input: {
    tenantId: string;
    name: string;
    email: string;
    passwordHash: string;
    role: string;
    pinHash?: string | null;
  }) {
    return runWithTenantContext({ tenantId: input.tenantId }, async () => {
      const [u] = await this.db
        .insert(users)
        .values({
          tenantId: input.tenantId,
          name: input.name,
          email: input.email,
          passwordHash: input.passwordHash,
          pinHash: input.pinHash ?? null,
          role: input.role,
          active: true,
        })
        .returning();
      return {
        id: u.id,
        tenantId: u.tenantId,
        name: u.name,
        email: u.email,
        role: u.role,
        active: u.active,
      };
    });
  }
}
