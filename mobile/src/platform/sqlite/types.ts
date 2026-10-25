// The better-sqlite3 subset the desktop SQLite engine uses (contracts/mobile-ports.md): connection.ts,
// transaction.ts, sequences.ts, queryable.ts, exactIntegers.ts and numericFunctions.ts. The phone shim
// (BetterSqliteShim.ts) and the Node test helper (test/helpers/nodeSqlite.ts) both implement it.

export type SqlValue = string | number | bigint | boolean | null | Uint8Array;

export interface RunResult {
  changes: number;
  lastInsertRowid: number | bigint;
}

export interface ShimStatement {
  /** True when the statement returns rows (SELECT, or INSERT … RETURNING). */
  readonly reader: boolean;
  /** True when the statement writes nothing. */
  readonly readonly: boolean;
  run(...params: unknown[]): RunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
  iterate(...params: unknown[]): IterableIterator<unknown>;
  raw(toggle?: boolean): this;
  pluck(toggle?: boolean): this;
  safeIntegers(toggle?: boolean): this;
}

export interface FunctionOptions {
  deterministic?: boolean;
  safeIntegers?: boolean;
  varargs?: boolean;
}

export interface AggregateOptions<T = unknown> {
  start?: T | (() => T);
  step: (total: T, ...args: unknown[]) => T | void;
  result?: (total: T) => unknown;
  deterministic?: boolean;
  safeIntegers?: boolean;
}

export interface ShimDatabase {
  readonly open: boolean;
  readonly inTransaction: boolean;
  prepare(sql: string): ShimStatement;
  exec(sql: string): this;
  pragma(source: string, options?: { simple?: boolean }): unknown;
  function(
    name: string,
    optionsOrFn: FunctionOptions | ((...args: unknown[]) => unknown),
    fn?: (...args: unknown[]) => unknown,
  ): this;
  aggregate<T = unknown>(name: string, options: AggregateOptions<T>): this;
  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R;
  close(): this;
  /** Closes the connection and deletes the database file (wipe). */
  destroy(): void;
}
