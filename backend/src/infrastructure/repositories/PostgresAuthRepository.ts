import { eq, and } from "drizzle-orm";
import type { DB } from "../orm/drizzle.js";
import type { IAuthRepository } from "../../application/ports/IAuthRepository.js";
import { users } from "../orm/schemas/user.table.js";

export class PostgresAuthRepository implements IAuthRepository {
  constructor(private readonly db: DB) {}

  async findUserByEmail(email: string, tenantId?: string) {
    const conditions = [eq(users.email, email)];
    if (tenantId) {
      conditions.push(eq(users.tenantId, tenantId));
    }
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
      role: u.role,
      active: u.active,
    };
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
    };
  }

  async createUser(input: {
    tenantId: string;
    name: string;
    email: string;
    passwordHash: string;
    role: string;
  }) {
    const [u] = await this.db
      .insert(users)
      .values({
        tenantId: input.tenantId,
        name: input.name,
        email: input.email,
        passwordHash: input.passwordHash,
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
  }
}
