/**
 * SQLite connections for the desktop engine (specs/001-desktop-sqlite-engine T041,
 * research R3/R4, constitution Principle IV — durability is not negotiable).
 *
 * Two better-sqlite3 connections on one database file:
 *   - writer: the only connection that ever writes; owned exclusively by the write gate
 *     (transaction.ts), so no statement can slip into another caller's transaction;
 *   - reader: read-only, for reads outside a transaction (WAL gives it the last committed
 *     snapshot — the same visibility PG gives a second pooled connection).
 *
 * Every PRAGMA is asserted after it is set; a value that does not hold is fatal. The
 * durability settings are fixed here and nowhere else: journal_mode=WAL with
 * synchronous=FULL (a committed transaction survives power loss), never OFF/NORMAL/MEMORY.
 * The schema calls no app-defined functions, so trusted_schema=OFF is safe to enforce.
 */
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import type { SQL } from "drizzle-orm";
import { withExactIntegers } from "./exactIntegers.js";
import { registerNumericFunctions } from "./numericFunctions.js";

type BaseSqliteDb = BetterSQLite3Database<Record<string, never>>;
/** PG's `execute(sql)` result shape (node-pg QueryResult subset). */
export interface ExecuteResult<R = Record<string, unknown>> {
  rows: R[];
  rowCount: number;
}
/**
 * The Drizzle SQLite handle as the transaction layer exposes it: `transaction` is async
 * (savepoint/gate, transaction.ts) and `execute` mirrors PG's raw-SQL result shape.
 */
export type SqliteDb = Omit<BaseSqliteDb, "transaction"> & {
  transaction<T>(fn: (tx: SqliteDb) => Promise<T>): Promise<T>;
  execute<R = Record<string, unknown>>(query: SQL): Promise<ExecuteResult<R>>;
};

export interface SqliteConnections {
  readonly path: string;
  readonly writer: Database.Database;
  readonly reader: Database.Database;
  /** Drizzle on the writer — only the write gate may hand this out. */
  readonly writerDb: SqliteDb;
  /** Drizzle on the read-only reader. */
  readonly readerDb: SqliteDb;
}

export class SqlitePragmaError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SqlitePragmaError";
  }
}

/** Reader wait for the rare WAL-recovery lock; the writer never waits (it is the only writer). */
const READER_BUSY_TIMEOUT_MS = 5000;

function setAndAssert(db: Database.Database, role: string, pragma: string, value: string | number, expected: unknown): void {
  db.pragma(`${pragma} = ${value}`);
  const actual = db.pragma(pragma, { simple: true });
  if (String(actual).toLowerCase() !== String(expected).toLowerCase()) {
    throw new SqlitePragmaError(`SQLite ${role}: PRAGMA ${pragma} is ${String(actual)}, required ${String(expected)}`);
  }
}

function assertPragma(db: Database.Database, role: string, pragma: string, expected: unknown): void {
  const actual = db.pragma(pragma, { simple: true });
  if (String(actual).toLowerCase() !== String(expected).toLowerCase()) {
    throw new SqlitePragmaError(`SQLite ${role}: PRAGMA ${pragma} is ${String(actual)}, required ${String(expected)}`);
  }
}

function hardenCommon(db: Database.Database, role: string): void {
  setAndAssert(db, role, "foreign_keys", "ON", 1);
  setAndAssert(db, role, "trusted_schema", "OFF", 0);
  setAndAssert(db, role, "cell_size_check", "ON", 1);
  registerNumericFunctions(db); // exact PG numeric division in queries (numericFunctions.ts)
}

/**
 * Open the writer and reader on `path`.
 * `create: true` is passed only when the runtime decided FRESH (contracts/data-root-and-startup-states.md);
 * otherwise a missing file is an error — a database is never created implicitly.
 */
export function openSqlite(path: string, opts: { create?: boolean } = {}): SqliteConnections {
  const writer = new Database(path, { fileMustExist: !opts.create });
  try {
    setAndAssert(writer, "writer", "journal_mode", "WAL", "wal");
    setAndAssert(writer, "writer", "synchronous", "FULL", 2);
    hardenCommon(writer, "writer");
  } catch (e) {
    writer.close();
    throw e;
  }
  let reader: Database.Database;
  try {
    reader = new Database(path, { readonly: true, fileMustExist: true });
    assertPragma(reader, "reader", "journal_mode", "wal");
    setAndAssert(reader, "reader", "synchronous", "FULL", 2);
    hardenCommon(reader, "reader");
    setAndAssert(reader, "reader", "busy_timeout", READER_BUSY_TIMEOUT_MS, READER_BUSY_TIMEOUT_MS);
  } catch (e) {
    writer.close();
    throw e;
  }
  return {
    path,
    writer,
    reader,
    writerDb: drizzle(withExactIntegers(writer)) as unknown as SqliteDb,
    readerDb: drizzle(withExactIntegers(reader)) as unknown as SqliteDb,
  };
}

/** Graceful shutdown: fold the WAL back into the main file, then close both connections. */
export function closeSqlite(c: SqliteConnections): void {
  try {
    if (c.writer.open && !c.writer.inTransaction) c.writer.pragma("wal_checkpoint(TRUNCATE)");
  } finally {
    if (c.reader.open) c.reader.close();
    if (c.writer.open) c.writer.close();
  }
}
