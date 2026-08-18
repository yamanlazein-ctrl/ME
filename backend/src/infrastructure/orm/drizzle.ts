import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { Pool } from "pg";
import { config } from "../config/env.js";

// Connection pool sizing rationale:
// max: 20 — balanced for ~50 concurrent users on a t3.small (2 vCPU).
// Node.js event loop can handle more, but PostgreSQL connections consume
// RAM (~5MB each) and backend workers. 20 allows enough headroom for
// burst traffic while avoiding connection-starvation from idle holders.
// idleTimeoutMillis: 30000 — releases idle connections after 30s to
// return resources to the pool. connectionTimeoutMillis: 5000 — fails
// fast (5s) rather than hanging when DB is unreachable.
export const pool = new Pool({
  connectionString: config.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

export const db = drizzle(pool);

/** Set RLS tenant context for the current connection session — call once per request before queries */
export async function setTenantForRequest(tenantId: string): Promise<void> {
  await pool.query("SET LOCAL app.current_tenant_id = $1", [tenantId]);
}

export type DB = typeof db;

/**
 * The transaction type used by `withTenantTx`. Derived from drizzle's
 * `db.transaction` callback parameter so it stays in sync with the schema.
 */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Run `fn` inside a transaction with the RLS tenant GUC set on the
 * SAME connection that executes the queries.
 *
 * `SET LOCAL` is issued inside the transaction so it applies only to
 * that transaction and is automatically reset on commit/rollback — this
 * is what makes RLS tenant isolation correct for multi-tenant writes.
 * The pooled client is released back to the pool afterwards.
 */
export async function withTenantTx<T>(
  tenantId: string,
  fn: (tx: Tx) => Promise<T>,
): Promise<T> {
  const client = await pool.connect();
  try {
    const txDb = drizzle(client);
    return await txDb.transaction(async (tx) => {
      // SET does NOT accept bind parameters — inline the tenantId as a literal
      // (tenantId is a UUID; still escape quotes defensively).
      await tx.execute(
        sql.raw(`SET LOCAL app.current_tenant_id = '${tenantId.replace(/'/g, "''")}'`),
      );
      return fn(tx);
    });
  } finally {
    client.release();
  }
}

// Health check helper
export async function checkDatabase(): Promise<boolean> {
  try {
    const client = await pool.connect();
    await client.query("SELECT 1");
    client.release();
    return true;
  } catch {
    return false;
  }
}
