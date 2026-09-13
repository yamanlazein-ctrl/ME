import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import { Pool, PoolClient } from "pg";
import { config } from "../config/env.js";
import { tenantContext } from "./tenant-context.js";
import { runInAmbientTx, getAmbientTx, getAmbientTenantId } from "./ambient-tx.js";

/**
 * A pg Pool that stamps the RLS tenant GUC onto every connection at checkout
 * time, keyed by the AsyncLocalStorage request context.
 *
 * This is the ONLY thing that makes multi-tenant RLS correct against a shared
 * pool: it sets `app.current_tenant_id` (and `app.platform_mode` when present)
 * on the exact connection that is about to run the request's queries, and
 * every query path (single statement via `Pool.query()`, and transactions via
 * `db.transaction()` / `withTenantTx()` → `Pool.connect()`) funnels through
 * `connect()`. The connection is then released back to the pool, and the next
 * checkout re-stamps it from the next request's context — so there is never a
 * window where a stale tenant leaks across requests.
 */
class TenantScopedPool extends Pool {
  override connect(): Promise<PoolClient>;
  override connect(
    callback: (
      err: Error | undefined,
      client: PoolClient | undefined,
      done: (release?: () => void) => void,
    ) => void,
  ): void;
  override connect(
    callback?: (
      err: Error | undefined,
      client: PoolClient | undefined,
      done: (release?: () => void) => void,
    ) => void,
  ): Promise<PoolClient> | void {
    const stamp = (client: PoolClient): Promise<PoolClient> => {
      const ctx = tenantContext.getStore();
      // set_config(..., is_local = false) == SET (session level). Because the
      // pool REUSES connections across requests, a session-level GUC set here
      // SURVIVES until the next checkout — so we must ALWAYS overwrite BOTH
      // GUCs on every checkout (including resetting them to NULL when the
      // current context has no tenant / is not platform). Otherwise a
      // platform request (app.platform_mode='on') would leak that flag to the
      // next tenant request reusing the same connection, letting a tenant see
      // other tenants' category-2 rows.
      const stmts: Promise<unknown>[] = [
        client.query("SELECT set_config('app.current_tenant_id', $1, false)", [
          ctx?.tenantId ?? null,
        ]),
        client.query("SELECT set_config('app.platform_mode', $1, false)", [
          ctx?.platformMode ? "on" : null,
        ]),
      ];
      return Promise.all(stmts).then(() => client);
    };

    if (callback) {
      super.connect((err, client, done) => {
        if (err) {
          callback(err, undefined, done);
          return;
        }
        stamp(client!).then(
          (c) => callback(undefined, c, done),
          (e) => callback(e, undefined, done),
        );
      });
      return;
    }
    return super.connect().then(stamp);
  }
}

// Connection pool sizing rationale:
// max: 20 — balanced for ~50 concurrent users on a t3.small (2 vCPU).
// Node.js event loop can handle more, but PostgreSQL connections consume
// RAM (~5MB each) and backend workers. 20 allows enough headroom for
// burst traffic while avoiding connection-starvation from idle holders.
// idleTimeoutMillis: 30000 — releases idle connections after 30s to
// return resources to the pool. connectionTimeoutMillis: 5000 — fails
// fast (5s) rather than hanging when DB is unreachable.
export const pool = new TenantScopedPool({
  connectionString: config.DATABASE_URL,
  max: 20,
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
});

export const db = drizzle(pool);

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
 *
 * F-07 (Transactional Outbox): the callback also runs inside
 * `runInAmbientTx`, so any repository holding an `ambientDb()` proxy executes
 * its statements on THIS transaction instead of borrowing a second connection
 * from the pool. That is what makes "business write + outbox enqueue" a single
 * atomic unit: the route wraps both in one `withTenantTx`, and a failure in
 * either rolls back both.
 *
 * Nested calls join the outer transaction as a savepoint (see below), so a
 * repository that opens `withTenantTx` internally can never commit behind the
 * route's back.
 */
export async function withTenantTx<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (!tenantId) throw new Error("tenantId is required");
  // F-07 nesting: when an ambient tenant transaction is ALREADY active (a
  // repository that manages its own transaction being called from a route
  // that opened one), JOIN it as a SAVEPOINT instead of checking out a second
  // pooled connection. A second connection would commit independently of the
  // caller's transaction — which is exactly the "business write committed
  // without its sync unit" divergence this mechanism exists to prevent.
  // Verified live: PostgresCompanyRepository used to open its own transaction
  // inside the route's, so PUT /api/company/profile committed the profile even
  // when the outbox insert failed.
  const ambient = getAmbientTx<Tx>();
  if (ambient) {
    const ambientTenant = getAmbientTenantId();
    if (ambientTenant && ambientTenant !== tenantId) {
      throw new Error(
        `withTenantTx: refusing to join an ambient transaction for tenant ${ambientTenant} with tenant ${tenantId}`,
      );
    }
    // Drizzle maps `tx.transaction(cb)` on an active transaction to a
    // SAVEPOINT on the SAME connection: an inner failure rolls back only its
    // own work, and the RLS GUC set by the outer `SET LOCAL` still applies.
    return ambient.transaction((savepoint) => fn(savepoint as unknown as Tx));
  }
  const client = await pool.connect();
  try {
    const txDb = drizzle(client);
    return await txDb.transaction(async (tx) => {
      // SET does NOT accept bind parameters — inline the tenantId as a literal
      // (tenantId is a UUID; still escape quotes defensively).
      await tx.execute(
        sql.raw(`SET LOCAL app.current_tenant_id = '${tenantId.replace(/'/g, "''")}'`),
      );
      return runInAmbientTx(tx, tenantId, () => fn(tx));
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
