import { eq, and, like, or, sql } from "drizzle-orm";
import type { DB } from "../orm/drizzle.js";
import { runWithTenantContext } from "../orm/tenant-context.js";
import type {
  IUserRepository,
  UserFilter,
  CreateUserData,
  UserSyncSnapshot,
} from "../../application/ports/IUserRepository.js";
import type { UserData } from "../../domain/entities/User.js";
import type { TenantContext, PaginatedResult } from "../../domain/types/index.js";
import { users } from "../orm/schemas/user.table.js";
import { invalidateIdentityCache } from "../auth/sessionCutoff.js";

export class PostgresUserRepository implements IUserRepository {
  constructor(private readonly db: DB) {}

  async findById(id: string, ctx: TenantContext): Promise<UserData | null> {
    return runWithTenantContext({ tenantId: ctx.tenantId }, async () => {
      const rows = await this.db
        .select({
          id: users.id,
          tenantId: users.tenantId,
          name: users.name,
          email: users.email,
          role: users.role,
          active: users.active,
          createdAt: users.createdAt,
        })
        .from(users)
        .where(eq(users.id, id))
        .limit(1);

      if (rows.length === 0) return null;
      const u = rows[0];
      return {
        id: u.id,
        tenantId: u.tenantId,
        name: u.name,
        email: u.email,
        role: u.role as UserData["role"],
        active: u.active,
        createdAt: u.createdAt.toISOString(),
      };
    });
  }

  async findByEmail(email: string, tenantId: string): Promise<UserData | null> {
    return runWithTenantContext({ tenantId }, async () => {
      const rows = await this.db
        .select({
          id: users.id,
          tenantId: users.tenantId,
          name: users.name,
          email: users.email,
          role: users.role,
          active: users.active,
          createdAt: users.createdAt,
        })
        .from(users)
        .where(and(eq(users.email, email), eq(users.tenantId, tenantId)))
        .limit(1);

      if (rows.length === 0) return null;
      const u = rows[0];
      return {
        id: u.id,
        tenantId: u.tenantId,
        name: u.name,
        email: u.email,
        role: u.role as UserData["role"],
        active: u.active,
        createdAt: u.createdAt.toISOString(),
      };
    });
  }

  async list(filter: UserFilter, ctx: TenantContext): Promise<PaginatedResult<UserData>> {
    return runWithTenantContext({ tenantId: ctx.tenantId }, async () => {
      const conditions = [eq(users.tenantId, ctx.tenantId)];

      if (filter.search) {
        const searchTerm = `%${filter.search}%`;
        conditions.push(
          or(
            like(users.name, searchTerm),
            like(users.email, searchTerm),
          )!,
        );
      }

      if (filter.role) {
        conditions.push(eq(users.role, filter.role));
      }

      if (filter.active !== undefined) {
        conditions.push(eq(users.active, filter.active));
      }

      const page = filter.page ?? 0;
      const limit = filter.limit ?? 20;
      const offset = page * limit;

      const [countResult, dataRows] = await Promise.all([
        this.db
          .select({ count: sql<number>`count(*)::int` })
          .from(users)
          .where(and(...conditions)),
        this.db
          .select({
            id: users.id,
            tenantId: users.tenantId,
            name: users.name,
            email: users.email,
            role: users.role,
            active: users.active,
            createdAt: users.createdAt,
          })
          .from(users)
          .where(and(...conditions))
          .orderBy(users.createdAt)
          .limit(limit)
          .offset(offset),
      ]);

      const total = countResult[0]?.count ?? 0;
      const totalPages = Math.ceil(total / limit);

      const data: UserData[] = dataRows.map((u) => ({
        id: u.id,
        tenantId: u.tenantId,
        name: u.name,
        email: u.email,
        role: u.role as UserData["role"],
        active: u.active,
        createdAt: u.createdAt.toISOString(),
      }));

      return {
        data,
        meta: {
          total,
          page,
          limit,
          hasNext: page + 1 < totalPages,
          totalPages,
        },
      };
    });
  }

  async create(data: CreateUserData, ctx: TenantContext): Promise<UserData> {
    return runWithTenantContext({ tenantId: ctx.tenantId }, async () => {
      const [u] = await this.db
        .insert(users)
        .values({
          tenantId: ctx.tenantId,
          name: data.name,
          email: data.email,
          passwordHash: data.password,
          role: data.role,
          active: data.active ?? true,
        })
        .returning({
          id: users.id,
          tenantId: users.tenantId,
          name: users.name,
          email: users.email,
          role: users.role,
          active: users.active,
          createdAt: users.createdAt,
        });

      return {
        id: u.id,
        tenantId: u.tenantId,
        name: u.name,
        email: u.email,
        role: u.role as UserData["role"],
        active: u.active,
        createdAt: u.createdAt.toISOString(),
      };
    });
  }

  async update(id: string, data: Partial<CreateUserData>, ctx: TenantContext): Promise<UserData> {
    return runWithTenantContext({ tenantId: ctx.tenantId }, async () => {
      const [u] = await this.db
        .update(users)
        .set({
          ...(data.name !== undefined && { name: data.name }),
          ...(data.email !== undefined && { email: data.email }),
          ...(data.password !== undefined && { passwordHash: data.password }),
          ...(data.role !== undefined && { role: data.role }),
          ...(data.active !== undefined && { active: data.active }),
          updatedAt: new Date(),
        })
        .where(and(eq(users.id, id), eq(users.tenantId, ctx.tenantId)))
        .returning({
          id: users.id,
          tenantId: users.tenantId,
          name: users.name,
          email: users.email,
          role: users.role,
          active: users.active,
          createdAt: users.createdAt,
        });

      if (!u) {
        throw new Error("User not found");
      }

      return {
        id: u.id,
        tenantId: u.tenantId,
        name: u.name,
        email: u.email,
        role: u.role as UserData["role"],
        active: u.active,
        createdAt: u.createdAt.toISOString(),
      };
    });
  }

  async delete(id: string, ctx: TenantContext): Promise<void> {
    return runWithTenantContext({ tenantId: ctx.tenantId }, async () => {
      // Soft delete: set active=false instead of hard delete
      // This preserves historical references (created_by in invoices/ledger)
        await this.db
        .update(users)
        .set({ active: false, tokensRevokedBefore: new Date(), updatedAt: new Date() })
        .where(and(eq(users.id, id), eq(users.tenantId, ctx.tenantId)));
      invalidateIdentityCache(id);
    });
  }

  async findSyncSnapshot(id: string, ctx: TenantContext): Promise<UserSyncSnapshot | null> {
    return runWithTenantContext({ tenantId: ctx.tenantId }, async () => {
      const rows = await this.db
        .select({
          id: users.id,
          tenantId: users.tenantId,
          name: users.name,
          email: users.email,
          role: users.role,
          active: users.active,
          passwordHash: users.passwordHash,
          pinHash: users.pinHash,
          updatedAt: users.updatedAt,
        })
        .from(users)
        .where(and(eq(users.id, id), eq(users.tenantId, ctx.tenantId)))
        .limit(1);
      const u = rows[0];
      if (!u) return null;
      return {
        id: u.id,
        tenantId: u.tenantId,
        name: u.name,
        email: u.email,
        role: u.role,
        active: u.active,
        passwordHash: u.passwordHash,
        pinHash: u.pinHash,
        updatedAt: u.updatedAt.toISOString(),
      };
    });
  }
}
