/**
 * Write gate + ambient transactions for the desktop SQLite engine
 * (specs/001-desktop-sqlite-engine T042/T043/T046; research R4, I-2, I-6, R13d).
 *
 * better-sqlite3 is synchronous and Drizzle's native SQLite transaction cannot span an
 * `await`, while the shared code runs `withTenantTx(id, async (tx) => …)`. So this layer
 * owns BEGIN/COMMIT itself:
 *
 *   - Write gate: a FIFO mutex with an unbounded queue in front of the single writer
 *     connection. A transaction holds it from `BEGIN IMMEDIATE` to `COMMIT`/`ROLLBACK`, so no
 *     other async flow can ever put a statement inside it.
 *   - Nesting: a nested `withTenantTx`/`runInTransaction`/`tx.transaction` joins as a SAVEPOINT
 *     (PG/Drizzle semantics); a nested call for a different tenant is refused like on PG.
 *   - Transaction clock: one µs timestamp per transaction (PG `now()`), bound for Drizzle
 *     defaults (clock.ts) and stamped into `motard_tx_state.ts` for the triggers.
 *   - Session flags (`allow_party_remap`, `allow_dye_purge`) live in `motard_tx_state`, set by
 *     allowLedgerPartyRemap/allowDyePurge and reset before COMMIT; ROLLBACK discards them.
 *   - Outside a transaction: reads go to the read-only reader; writes run as single-statement
 *     transactions through the gate.
 *   - Re-entry: acquiring the gate while this async context already holds it would deadlock;
 *     it fails loudly instead (an "autonomous" write — use runAutonomous, I-2).
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { getAmbientTx, getAmbientTenantId, runInAmbientTx, ambientDb } from "../ambient-tx.js";
import { formatMicrosUtc, nextMonotonicMicros, runWithTransactionClock } from "./clock.js";
import { bindSequenceConnection } from "./sequences.js";
import type { SqliteConnections, SqliteDb } from "./connection.js";

// ─── write gate ────────────────────────────────────────────────────────────

class WriteGate {
  private tail: Promise<void> = Promise.resolve();
  private waiting = 0;

  /** FIFO; the queue is unbounded by design (no artificial limit, research R4). */
  async acquire(): Promise<() => void> {
    let release!: () => void;
    const mine = new Promise<void>((r) => (release = r));
    const before = this.tail;
    this.tail = before.then(() => mine);
    this.waiting++;
    await before;
    this.waiting--;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        release();
      }
    };
  }

  get queued(): number {
    return this.waiting;
  }
}

interface TxState {
  /** Async context id that holds the gate (re-entry detection). */
  readonly owner: symbol;
  readonly tenantId: string;
  flagsSet: boolean;
  savepoints: number;
  /**
   * False once COMMIT/ROLLBACK ran. Async continuations started inside the transaction keep its
   * AsyncLocalStorage context after it ends (e.g. a fire-and-forget audit write); they must see
   * "no transaction" and take the independent path, never the finished transaction.
   */
  active: boolean;
  /** Autonomous writes to replay after a ROLLBACK (I-2). */
  readonly compensations: Array<() => Promise<unknown>>;
}

const txStore = new AsyncLocalStorage<TxState>();
const gate = new WriteGate();
let conns: SqliteConnections | null = null;
let txHandle: SqliteDb | null = null;
let outside: SqliteDb | null = null;
let independent: SqliteDb | null = null;
let ambient: SqliteDb | null = null;

/**
 * True when `text` is a read-only statement the reader connection can run. A statement the reader
 * cannot even prepare (DDL checked against the reader's schema view, which may lag a just-committed
 * schema change) is NOT classified there: it goes to the writer, which raises the real error if any.
 */
function readerCanServe(c: SqliteConnections, text: string): boolean {
  try {
    // `.reader` alone is also true for INSERT/UPDATE/DELETE … RETURNING (they return rows);
    // only a statement that returns rows AND writes nothing belongs on the read-only connection.
    const st = c.reader.prepare(text);
    return st.reader && st.readonly;
  } catch {
    return false;
  }
}

function connections(): SqliteConnections {
  if (!conns) throw new Error("SQLITE_NOT_INITIALIZED: initSqliteTransactions() was not called");
  return conns;
}

export class SqliteGateReentryError extends Error {
  constructor(what: string) {
    super(
      `SQLITE_GATE_REENTRY: ${what} while this async context holds the write gate — ` +
        "an independent write inside a transaction would deadlock the single writer; use runAutonomous()",
    );
    this.name = "SqliteGateReentryError";
  }
}

/** True when the current async context is inside a SQLite transaction (holds the gate). */
export function inSqliteTransaction(): boolean {
  return txStore.getStore()?.active === true;
}

// ─── transactions ──────────────────────────────────────────────────────────

async function savepoint<T>(fn: (tx: SqliteDb) => Promise<T>): Promise<T> {
  const state = txStore.getStore()!;
  if (!state.active) throw new Error("SQLITE_TX_ESCAPED: savepoint requested after the transaction ended");
  const name = `motard_sp_${++state.savepoints}`;
  const w = connections().writer;
  w.exec(`SAVEPOINT ${name}`);
  try {
    const result = await fn(txHandle!);
    w.exec(`RELEASE ${name}`);
    return result;
  } catch (e) {
    w.exec(`ROLLBACK TO ${name}`);
    w.exec(`RELEASE ${name}`);
    throw e;
  }
}

async function topLevel<T>(tenantId: string, fn: (tx: SqliteDb) => Promise<T>): Promise<T> {
  const c = connections();
  if (inSqliteTransaction()) throw new SqliteGateReentryError("a new top-level write transaction was requested");
  const release = await gate.acquire();
  const state: TxState = { owner: Symbol("tx"), tenantId, flagsSet: false, savepoints: 0, compensations: [], active: true };
  let rolledBack = false;
  try {
    const ts = formatMicrosUtc(nextMonotonicMicros());
    c.writer.exec("BEGIN IMMEDIATE");
    try {
      // Stamp the clock for the triggers; flags always start cleared (crash safety).
      c.writer.prepare("UPDATE motard_tx_state SET ts = ?, allow_party_remap = 0, allow_dye_purge = 0 WHERE id = 1").run(ts);
      const result = await txStore.run(state, () =>
        runWithTransactionClock(() => runInAmbientTx(txHandle!, tenantId, () => fn(txHandle!)), ts),
      );
      if (state.flagsSet) c.writer.exec("UPDATE motard_tx_state SET allow_party_remap = 0, allow_dye_purge = 0 WHERE id = 1");
      c.writer.exec("COMMIT");
      return result;
    } catch (e) {
      if (c.writer.inTransaction) c.writer.exec("ROLLBACK");
      rolledBack = true;
      throw e;
    }
  } finally {
    state.active = false;
    release();
    if (rolledBack && state.compensations.length) {
      // PG committed these autonomously on another connection; replay them so a failed outer
      // transaction consumes exactly what it consumes on PG (I-2). Each runs as its own transaction.
      for (const replay of state.compensations) await replay();
    }
  }
}

function assertSameTenant(tenantId: string): void {
  const ambientTenant = getAmbientTenantId();
  if (ambientTenant && ambientTenant !== tenantId) {
    throw new Error(
      `withTenantTx: refusing to join an ambient transaction for tenant ${ambientTenant} with tenant ${tenantId}`,
    );
  }
}

/** Run `fn` atomically for `tenantId`; nested calls join as a SAVEPOINT (same as PG). */
export async function withTenantTx<T>(tenantId: string, fn: (tx: SqliteDb) => Promise<T>): Promise<T> {
  if (!tenantId) throw new Error("tenantId is required");
  if (inSqliteTransaction() && getAmbientTx()) {
    assertSameTenant(tenantId);
    return savepoint(fn);
  }
  return topLevel(tenantId, fn);
}

/**
 * Plain (non-tenant) transaction. Nested inside another transaction it joins as a SAVEPOINT:
 * on PG a nested `db.transaction` on another pooled connection would commit independently,
 * which a single writer cannot do without deadlocking (T043 decision: join).
 */
export async function runInTransaction<T>(fn: (tx: SqliteDb) => Promise<T>): Promise<T> {
  if (inSqliteTransaction()) return savepoint(fn);
  return topLevel("", fn);
}

/**
 * A write that PostgreSQL commits autonomously (its own pooled connection, I-2), e.g. a
 * document number consumed inside a settlement that may still fail.
 *   - outside a transaction: runs as its own transaction;
 *   - inside one: joins it now (no deadlock, read-your-writes) AND is replayed in a fresh
 *     transaction if the outer one rolls back, so the effect survives exactly as on PG.
 * `fn` must be safe to re-run after a rollback (it re-applies the same increment).
 */
export async function runAutonomous<T>(fn: (tx: SqliteDb) => Promise<T>): Promise<T> {
  const state = txStore.getStore();
  if (!state?.active) return topLevel("", fn);
  state.compensations.push(() => topLevel(state.tenantId, fn));
  return savepoint(fn);
}

// ─── session flags (PG: the transaction-local app.allow_party_remap setting / dye-purge trigger drop) ──

function setFlag(column: "allow_party_remap" | "allow_dye_purge"): void {
  const state = txStore.getStore();
  if (!state?.active) throw new Error(`${column} must be set inside a transaction`);
  connections().writer.exec(`UPDATE motard_tx_state SET ${column} = 1 WHERE id = 1`);
  state.flagsSet = true;
}

/** Merge: allow ledger `party_id` remaps only, for the rest of this transaction. */
export async function allowLedgerPartyRemap(_tx: unknown): Promise<void> {
  setFlag("allow_party_remap");
}

/** Dye purge: allow ledger DELETE only (UPDATE stays guarded), for the rest of this transaction. */
export async function allowDyePurge(_tx: unknown): Promise<void> {
  setFlag("allow_dye_purge");
}

// ─── handles ───────────────────────────────────────────────────────────────

/**
 * Methods that EXECUTE an insert/update/delete builder. `values` is deliberately absent: on an
 * insert builder it is `.values(rows)` (building), not the raw-rows executor of a select.
 */
const EXEC = new Set(["then", "run", "all", "get", "execute"]);

/** Wrap a writer-side query builder so that executing it runs through the gate as one transaction. */
function gatedBuilder(builder: object): object {
  return new Proxy(builder, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== "function") return value;
      if (typeof prop === "string" && EXEC.has(prop)) {
        if (prop === "then") {
          return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
            topLevel("", async () => await (target as PromiseLike<unknown>)).then(resolve, reject);
        }
        return (...args: unknown[]) => topLevel("", async () => (value as (...a: unknown[]) => unknown).apply(target, args));
      }
      return (...args: unknown[]) => {
        const next = (value as (...a: unknown[]) => unknown).apply(target, args);
        return next && typeof next === "object" ? gatedBuilder(next as object) : next;
      };
    },
  });
}

type RawDb = { all(q: unknown): unknown[]; run(q: unknown): { changes: number }; dialect: { sqlToQuery(q: unknown): { sql: string } } };

/** PG `execute(sql)`: rows for a statement that returns data, else the change count. */
function executeOn(db: SqliteDb, conn: import("better-sqlite3").Database, q: unknown) {
  const raw = db as unknown as RawDb;
  const text = raw.dialect.sqlToQuery(q).sql;
  if (conn.prepare(text).reader) {
    const rows = raw.all(q);
    return { rows, rowCount: rows.length };
  }
  return { rows: [] as unknown[], rowCount: raw.run(q).changes };
}

function makeTxHandle(c: SqliteConnections): SqliteDb {
  return new Proxy(c.writerDb, {
    get(target, prop) {
      if (!inSqliteTransaction()) {
        throw new Error("SQLITE_TX_ESCAPED: a transaction handle was used after its transaction ended");
      }
      if (prop === "transaction") return (fn: (tx: SqliteDb) => Promise<unknown>) => savepoint(fn);
      if (prop === "execute") return async (q: unknown) => executeOn(target, c.writer, q);
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

function makeAmbientHandle(): SqliteDb {
  return new Proxy({} as SqliteDb, {
    get(_t, prop) {
      const target = (inSqliteTransaction() ? txHandle! : outside!) as unknown as Record<PropertyKey, unknown>;
      const value = target[prop];
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/** Builder whose execution runs through runAutonomous on the writer (see sqliteIndependentDb). */
function autonomousBuilder(builder: object): object {
  return new Proxy(builder, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== "function") return value;
      if (typeof prop === "string" && EXEC.has(prop)) {
        if (prop === "then") {
          return (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
            runAutonomous(async () => await (target as PromiseLike<unknown>)).then(resolve, reject);
        }
        return (...args: unknown[]) => runAutonomous(async () => (value as (...a: unknown[]) => unknown).apply(target, args));
      }
      return (...args: unknown[]) => {
        const next = (value as (...a: unknown[]) => unknown).apply(target, args);
        return next && typeof next === "object" ? autonomousBuilder(next as object) : next;
      };
    },
  });
}

function makeIndependentHandle(c: SqliteConnections): SqliteDb {
  return new Proxy(c.readerDb, {
    get(target, prop) {
      if (prop === "transaction") return (fn: (tx: SqliteDb) => Promise<unknown>) => runAutonomous(fn);
      if (prop === "insert" || prop === "update" || prop === "delete") {
        return (...args: unknown[]) =>
          autonomousBuilder(((c.writerDb as unknown as Record<string, (...a: unknown[]) => object>)[prop]).apply(c.writerDb, args));
      }
      if (prop === "run") {
        return (...args: unknown[]) => runAutonomous(async () => (c.writerDb.run as (...a: unknown[]) => unknown).apply(c.writerDb, args));
      }
      if (prop === "execute") {
        return async (q: unknown) => {
          const text = (c.readerDb as unknown as RawDb).dialect.sqlToQuery(q).sql;
          if (readerCanServe(c, text)) return executeOn(c.readerDb, c.reader, q);
          return runAutonomous(async () => executeOn(c.writerDb, c.writer, q));
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

function makeOutsideHandle(c: SqliteConnections): SqliteDb {
  return new Proxy(c.readerDb, {
    get(target, prop) {
      if (prop === "transaction") return (fn: (tx: SqliteDb) => Promise<unknown>) => runInTransaction(fn);
      if (prop === "insert" || prop === "update" || prop === "delete") {
        return (...args: unknown[]) =>
          gatedBuilder(((c.writerDb as unknown as Record<string, (...a: unknown[]) => object>)[prop]).apply(c.writerDb, args));
      }
      if (prop === "run") {
        return (...args: unknown[]) => topLevel("", async () => (c.writerDb.run as (...a: unknown[]) => unknown).apply(c.writerDb, args));
      }
      if (prop === "execute") {
        return async (q: unknown) => {
          const text = (c.readerDb as unknown as RawDb).dialect.sqlToQuery(q).sql;
          if (readerCanServe(c, text)) return executeOn(c.readerDb, c.reader, q);
          return topLevel("", async () => executeOn(c.writerDb, c.writer, q));
        };
      }
      const value = Reflect.get(target, prop, target) as unknown;
      return typeof value === "function" ? (value as (...a: unknown[]) => unknown).bind(target) : value;
    },
  });
}

/**
 * Bind the layer to opened connections (once per process; the connection layer calls this).
 * Gate re-entry detection is installed on the sequence source too: drawing a sequence value
 * outside a transaction would write on the writer behind the gate.
 */
export function initSqliteTransactions(c: SqliteConnections): void {
  conns = c;
  txHandle = makeTxHandle(c);
  outside = makeOutsideHandle(c);
  independent = makeIndependentHandle(c);
  ambient = makeAmbientHandle();
  bindSequenceConnection(c.writer, () => inSqliteTransaction());
}

export function resetSqliteTransactionsForTests(): void {
  conns = null;
  txHandle = null;
  outside = null;
  independent = null;
  ambient = null;
}

/**
 * Engine-neutral `txDb` for SQLite: the active transaction when there is one, else the outside
 * handle (reads on the reader, writes through the gate). Decided on every access, so a handle held
 * across a transaction's end never reaches the finished transaction.
 */
export function sqliteDb(): SqliteDb {
  if (!ambient) connections();
  return ambient!;
}

/**
 * For repositories that PostgreSQL wires to the RAW pool (audit, notifications, dashboard, …): their
 * writes commit on another pooled connection, independent of any route transaction. Here: reads on
 * the reader (no uncommitted data, as on another PG connection); writes, raw `run`/`execute` writes
 * and `transaction()` go through runAutonomous (joined + replayed after a rollback, or their own
 * transaction outside one).
 */
export function sqliteIndependentDb(): SqliteDb {
  if (!independent) connections();
  return independent!;
}

/** Queue depth of the write gate (diagnostics/tests). */
export function writeGateQueueLength(): number {
  return gate.queued;
}

/** Throws if called while this async context holds the gate (used by independent-connection code paths). */
export function assertNotInTransaction(what: string): void {
  if (inSqliteTransaction()) throw new SqliteGateReentryError(what);
}

/**
 * Run `fn` while holding the write gate without opening a transaction — for maintenance that
 * replaces the database file (restore swap). No writer can be mid-transaction meanwhile.
 */
export async function withWriteGateHeld<T>(fn: () => Promise<T> | T): Promise<T> {
  if (inSqliteTransaction()) throw new SqliteGateReentryError("exclusive maintenance was requested");
  const release = await gate.acquire();
  try {
    return await fn();
  } finally {
    release();
  }
}
