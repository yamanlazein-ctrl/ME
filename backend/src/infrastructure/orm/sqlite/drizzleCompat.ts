/**
 * The `orm/drizzle.ts` surface for SQLite twins (specs/001-desktop-sqlite-engine S4): same export
 * names, so ported repositories keep the PG code shape.
 *   - `db`/`txDb`: the ambient SQLite handle — the open transaction when one is active, otherwise
 *     reads on the reader and writes through the write gate (transaction.ts).
 *   - `withTenantTx`, `allowLedgerPartyRemap`, `ambientDb`: the SQLite transaction layer.
 */
import type { SqliteDb } from "./connection.js";
import { sqliteDb, withTenantTx, allowLedgerPartyRemap, runInTransaction } from "./transaction.js";
import { ambientDb } from "../ambient-tx.js";

export type DB = SqliteDb;
export type Tx = SqliteDb;

/** Lazily bound: resolves the ambient handle on every property access. */
export const db: SqliteDb = new Proxy({} as SqliteDb, {
  get(_t, prop) {
    const target = sqliteDb() as unknown as Record<PropertyKey, unknown>;
    const value = target[prop];
    return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
  },
});
export const txDb = db;

export { withTenantTx, allowLedgerPartyRemap, ambientDb, runInTransaction };
