import { eq, count } from "drizzle-orm";
import { db as defaultDb, type DB } from "../orm/drizzle.js";
import { systemAdmins } from "../orm/schemas/system-admin.table.js";

/**
 * System-level Super Admin persistence. Distinct from tenant `users`.
 * Frozen Architecture Specification §2.1, §6.
 */
export interface SystemAdminRow {
  id: string;
  email: string;
  passwordHash: string;
  name: string | null;
  role: string;
}

export class PostgresSystemAdminRepository {
  constructor(private readonly db: DB = defaultDb) {}

  async findByEmail(email: string): Promise<SystemAdminRow | null> {
    const [row] = await this.db
      .select()
      .from(systemAdmins)
      .where(eq(systemAdmins.email, email.toLowerCase().trim()))
      .limit(1);
    if (!row) return null;
    return { id: row.id, email: row.email, passwordHash: row.passwordHash, name: row.name, role: row.role };
  }

  async create(input: {
    email: string;
    passwordHash: string;
    name?: string | null;
    role?: string;
  }): Promise<SystemAdminRow> {
    const [row] = await this.db
      .insert(systemAdmins)
      .values({
        email: input.email.toLowerCase().trim(),
        passwordHash: input.passwordHash,
        name: input.name ?? null,
        role: input.role ?? "super_admin",
      })
      .returning();
    return { id: row.id, email: row.email, passwordHash: row.passwordHash, name: row.name, role: row.role };
  }

  async count(): Promise<number> {
    const [{ c }] = await this.db.select({ c: count() }).from(systemAdmins);
    return Number(c);
  }
}
