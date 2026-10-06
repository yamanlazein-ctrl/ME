/** PostgreSQL deep-health probes — moved verbatim from health.route.ts (S1). */
import { sql } from "drizzle-orm";
import type { DB } from "../orm/drizzle.js";
import type { IHealthRepository } from "../../application/ports/IHealthRepository.js";

export class PostgresHealthRepository implements IHealthRepository {
  constructor(private readonly db: DB) {}

  async ping(): Promise<void> {
    await this.db.execute(sql`SELECT 1`);
  }

  async databaseSize(): Promise<string> {
    const sizeResult = await this.db.execute(sql`
        SELECT pg_size_pretty(pg_database_size(current_database())) as size
      `);
    return ((sizeResult as unknown as { rows: Array<{ size?: string }> }).rows[0]?.size) ?? "unknown";
  }
}
