/**
 * Engine-neutral transaction facade (specs/001-desktop-sqlite-engine, stage S1,
 * contracts/db-engine-port.md).
 *
 * Code that only needs "run this atomically for this tenant" imports from here
 * instead of `drizzle.ts`, so it runs unchanged on either engine:
 *   - DB_ENGINE=postgres (default, cloud + today's desktop): delegates 1:1 to
 *     `drizzle.ts` — same pool, same RLS GUCs, same ambient-transaction nesting.
 *   - DB_ENGINE=sqlite (desktop): delegates to the SQLite connection layer
 *     (`sqlite/transaction.ts`, stage S3).
 *
 * The engine modules are loaded lazily on first use: `drizzle.ts` opens a
 * PostgreSQL pool at import time, so a SQLite process must never import it.
 */
import { config } from "../config/env.js";
import type { Tx } from "./drizzle.js";

export type DbEngine = "postgres" | "sqlite";
export type { Tx };

export function getEngine(): DbEngine {
  return config.DB_ENGINE;
}

type PgModule = typeof import("./drizzle.js");
let pgModule: Promise<PgModule> | null = null;
function postgres(): Promise<PgModule> {
  pgModule ??= import("./drizzle.js");
  return pgModule;
}

/** The SQLite transaction layer (stage S3, tasks T042/T046); boots the runtime on first use. */
type SqliteTxModule = typeof import("./sqlite/transaction.js");
let sqliteModule: Promise<SqliteTxModule> | null = null;
function sqlite(): Promise<SqliteTxModule> {
  sqliteModule ??= (async () => {
    const { ensureSqliteRuntime } = await import("./sqlite/runtime.js");
    await ensureSqliteRuntime();
    return import("./sqlite/transaction.js");
  })();
  return sqliteModule;
}
/** The SQLite handle is a Drizzle SQLite database; callers on that engine use SQLite repositories. */
const asSqliteFn = <T>(fn: (tx: Tx) => Promise<T>) => fn as unknown as (tx: unknown) => Promise<T>;

/**
 * Run `fn` atomically for `tenantId`. Nested calls join the outer transaction
 * as a savepoint (both engines), so a repository that opens its own
 * transaction can never commit behind the caller's back.
 */
export async function withTenantTx<T>(tenantId: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (getEngine() === "sqlite") return (await sqlite()).withTenantTx(tenantId, asSqliteFn(fn));
  return (await postgres()).withTenantTx(tenantId, fn);
}

/** Run `fn` in a plain (non-tenant-scoped) transaction. */
export async function runInTransaction<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (getEngine() === "sqlite") return (await sqlite()).runInTransaction(asSqliteFn(fn));
  const { db } = await postgres();
  return db.transaction(fn);
}

/**
 * A write that must survive the caller's transaction rolling back (research I-2), e.g. a
 * document number consumed by a settlement that still fails:
 *   - PostgreSQL: its own transaction on another pooled connection (today's behavior);
 *   - SQLite: joins the caller's transaction and is replayed after a rollback (single writer).
 */
export async function runAutonomous<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
  if (getEngine() === "sqlite") return (await sqlite()).runAutonomous(asSqliteFn(fn));
  const { db } = await postgres();
  return db.transaction(fn);
}

/** Merge: allow ledger `party_id` remaps for the rest of the current transaction (both engines). */
export async function allowLedgerPartyRemap(tx: Tx): Promise<void> {
  if (getEngine() === "sqlite") return (await sqlite()).allowLedgerPartyRemap(tx);
  return (await postgres()).allowLedgerPartyRemap(tx);
}

/** Readiness probe for /api/health/ready on either engine. */
export async function checkDatabase(): Promise<boolean> {
  if (getEngine() === "sqlite") {
    try {
      const { sql } = await import("drizzle-orm");
      await (await sqlite()).sqliteDb().execute(sql`SELECT 1`);
      return true;
    } catch {
      return false;
    }
  }
  return (await postgres()).checkDatabase();
}
