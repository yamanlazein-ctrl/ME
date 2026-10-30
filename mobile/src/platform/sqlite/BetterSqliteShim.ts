// better-sqlite3 look-alike over @op-engineering/op-sqlite (research R2, spike S1). Metro maps the module
// name `better-sqlite3` to this file. Only the subset in types.ts exists.
//
// Known limits, reported by the S1 screen rather than hidden:
//  - op-sqlite 18 has no JavaScript user-defined SQL functions; patches/@op-engineering+op-sqlite+18.2.5.patch adds
//    `createFunction` / `createAggregate` (JSI callbacks, synchronous calls only) and 64-bit integers beyond ±2^53 come
//    back as BigInt (tasks T044 / FIX-02). Without the patch `function` / `aggregate` throw "UDF_UNSUPPORTED".
import { open } from "@op-engineering/op-sqlite";
import type {
  AggregateOptions,
  FunctionOptions,
  RunResult,
  ShimDatabase,
  ShimStatement,
} from "./types";

type Scalar = string | number | boolean | null | ArrayBuffer | ArrayBufferView;

/** The op-sqlite connection members the shim uses. */
export interface OpConnection {
  executeSync(
    query: string,
    params?: Scalar[],
  ): { rows: Array<Record<string, Scalar>>; rowsAffected: number; insertId?: number };
  executeRawSync(
    query: string,
    params?: Scalar[],
  ): { rawRows: Scalar[][]; columnNames: string[]; rowsAffected: number; insertId?: number };
  /**
   * Motard patch of op-sqlite (patches/@op-engineering+op-sqlite+18.2.5.patch): JavaScript SQL functions. They run only
   * inside the synchronous execute calls, which is all the shim uses.
   */
  createFunction?(name: string, deterministic: boolean, fn: (...args: unknown[]) => unknown): void;
  createAggregate?(
    name: string,
    spec: {
      start: () => unknown;
      step: (acc: unknown, ...args: unknown[]) => unknown;
      result: (acc: unknown) => unknown;
    },
  ): void;
  close(): void;
  /** op-sqlite: closes and deletes the database file. */
  delete?(): void;
}

export interface ShimOpenOptions {
  name: string;
  encryptionKey?: string;
  /** Test seam: an already-open connection. */
  connection?: OpConnection;
}

const CODE_BY_MESSAGE: Array<[RegExp, string]> = [
  [/UNIQUE constraint failed/i, "SQLITE_CONSTRAINT_UNIQUE"],
  [/NOT NULL constraint failed/i, "SQLITE_CONSTRAINT_NOTNULL"],
  [/FOREIGN KEY constraint failed/i, "SQLITE_CONSTRAINT_FOREIGNKEY"],
  [/CHECK constraint failed/i, "SQLITE_CONSTRAINT_CHECK"],
  [/datatype mismatch/i, "SQLITE_MISMATCH"],
  [/database is locked/i, "SQLITE_BUSY"],
  [/database or disk is full/i, "SQLITE_FULL"],
];

/**
 * better-sqlite3 errors carry `code: "SQLITE_CONSTRAINT_UNIQUE"`; op-sqlite errors only carry the message. The desktop's
 * error mapper (backend .../sqlite/errors.ts) keys on the code, so a duplicate name on the phone would otherwise show
 * the generic "unexpected error" text instead of "اسم مستخدم مسبقاً". Adds the code derived from SQLite's own message.
 */
export function withSqliteCode(error: unknown): unknown {
  if (!(error instanceof Error)) return error;
  const existing = (error as { code?: unknown }).code;
  if (typeof existing === "string" && existing.startsWith("SQLITE_")) return error;
  const hit = CODE_BY_MESSAGE.find(([re]) => re.test(error.message));
  if (hit) (error as { code?: string }).code = hit[1];
  return error;
}

const MAX_SAFE = BigInt(Number.MAX_SAFE_INTEGER);
const MIN_SAFE = BigInt(Number.MIN_SAFE_INTEGER);

function toScalar(value: unknown): Scalar {
  if (value === undefined || value === null) return null;
  if (typeof value === "bigint") {
    // Text keeps all digits; SQLite converts it back to INTEGER for INTEGER-affinity columns.
    return value >= MIN_SAFE && value <= MAX_SAFE ? Number(value) : value.toString();
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  if (value instanceof Uint8Array) {
    return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength) as ArrayBuffer;
  }
  return value as Scalar;
}

function flatten(params: unknown[]): Scalar[] {
  const list = params.length === 1 && Array.isArray(params[0]) ? (params[0] as unknown[]) : params;
  return list.map(toScalar);
}

const READ_START = /^\s*(select|with|values|explain)\b/i;
const HAS_RETURNING = /\breturning\b/i;

function classify(sql: string): { reader: boolean; readonly: boolean } {
  const trimmed = sql.trim();
  const pragmaRead = /^pragma\b/i.test(trimmed) && !trimmed.includes("=");
  const select = READ_START.test(trimmed);
  const writesWithWith =
    /^\s*with\b/i.test(trimmed) && /\b(insert|update|delete|replace)\b/i.test(trimmed);
  const readonly = (select && !writesWithWith) || pragmaRead;
  return { reader: select || pragmaRead || HAS_RETURNING.test(trimmed), readonly };
}

/** Splits a script into statements; semicolons inside strings, comments and CREATE TRIGGER … END stay. */
export function splitStatements(script: string): string[] {
  const out: string[] = [];
  let current = "";
  let i = 0;
  let triggerDepth = 0;
  const n = script.length;
  while (i < n) {
    const ch = script[i] as string;
    const next = script[i + 1];
    if (ch === "-" && next === "-") {
      const end = script.indexOf("\n", i);
      const stop = end === -1 ? n : end;
      current += script.slice(i, stop);
      i = stop;
    } else if (ch === "/" && next === "*") {
      const end = script.indexOf("*/", i + 2);
      const stop = end === -1 ? n : end + 2;
      current += script.slice(i, stop);
      i = stop;
    } else if (ch === "'" || ch === '"' || ch === "`") {
      let j = i + 1;
      while (j < n) {
        if (script[j] === ch) {
          if (script[j + 1] === ch) j += 2;
          else break;
        } else j++;
      }
      current += script.slice(i, j + 1);
      i = j + 1;
    } else if (ch === ";" && triggerDepth === 0) {
      if (current.trim()) out.push(current.trim());
      current = "";
      i++;
    } else {
      current += ch;
      i++;
      if (/[A-Za-z_]/.test(ch) && !/[A-Za-z0-9_]/.test(script[i - 2] ?? " ")) {
        let j = i;
        while (j < n && /[A-Za-z0-9_]/.test(script[j] as string)) j++;
        const word = script.slice(i - 1, j).toUpperCase();
        if (word === "BEGIN" && /\bTRIGGER\b/i.test(current)) triggerDepth++;
        else if (word === "CASE" && triggerDepth > 0) triggerDepth++;
        else if (word === "END" && triggerDepth > 0) triggerDepth--;
        current += script.slice(i, j);
        i = j;
      }
    }
  }
  if (current.trim()) out.push(current.trim());
  return out;
}

class ShimStatementImpl implements ShimStatement {
  readonly reader: boolean;
  readonly readonly: boolean;
  private rawMode = false;
  private pluckMode = false;

  constructor(
    private readonly db: ShimDatabaseImpl,
    private readonly sql: string,
  ) {
    const kind = classify(sql);
    this.reader = kind.reader;
    this.readonly = kind.readonly;
  }

  raw(toggle = true): this {
    this.rawMode = toggle;
    return this;
  }

  pluck(toggle = true): this {
    this.pluckMode = toggle;
    return this;
  }

  safeIntegers(): this {
    return this; // op-sqlite returns numbers; see the limits in the file header
  }

  run(...params: unknown[]): RunResult {
    const result = this.db.execute(this.sql, flatten(params));
    return { changes: result.rowsAffected, lastInsertRowid: result.insertId ?? 0 };
  }

  private rows(params: unknown[]): unknown[] {
    const args = flatten(params);
    if (this.pluckMode) {
      return this.db.executeRaw(this.sql, args).rawRows.map((r) => r[0]);
    }
    if (this.rawMode) return this.db.executeRaw(this.sql, args).rawRows;
    return this.db.execute(this.sql, args).rows;
  }

  get(...params: unknown[]): unknown {
    return this.rows(params)[0];
  }

  all(...params: unknown[]): unknown[] {
    return this.rows(params);
  }

  *iterate(...params: unknown[]): IterableIterator<unknown> {
    for (const row of this.rows(params)) yield row;
  }
}

class ShimDatabaseImpl implements ShimDatabase {
  open = true;
  inTransaction = false;

  constructor(private readonly conn: OpConnection) {}

  private track(sql: string): void {
    const head = sql.trimStart().slice(0, 12).toUpperCase();
    if (head.startsWith("BEGIN")) this.inTransaction = true;
    else if (head.startsWith("COMMIT") || head.startsWith("END")) this.inTransaction = false;
    else if (
      head.startsWith("ROLLBACK") &&
      !/^ROLLBACK\s+(TRANSACTION\s+)?TO\b/i.test(sql.trimStart())
    ) {
      this.inTransaction = false;
    }
  }

  execute(sql: string, params: Scalar[]) {
    try {
      const result = this.conn.executeSync(sql, params);
      this.track(sql);
      return result;
    } catch (e) {
      throw withSqliteCode(e);
    }
  }

  executeRaw(sql: string, params: Scalar[]) {
    try {
      const result = this.conn.executeRawSync(sql, params);
      this.track(sql);
      return result;
    } catch (e) {
      throw withSqliteCode(e);
    }
  }

  prepare(sql: string): ShimStatement {
    return new ShimStatementImpl(this, sql);
  }

  exec(sql: string): this {
    for (const statement of splitStatements(sql)) this.execute(statement, []);
    return this;
  }

  pragma(source: string, options?: { simple?: boolean }): unknown {
    const result = this.executeRaw(`PRAGMA ${source}`, []);
    if (options?.simple) return result.rawRows[0]?.[0];
    return result.columnNames.length
      ? result.rawRows.map((row) =>
          Object.fromEntries(row.map((v, i) => [result.columnNames[i], v])),
        )
      : [];
  }

  function(
    name: string,
    optionsOrFn: FunctionOptions | ((...args: unknown[]) => unknown),
    maybeFn?: (...args: unknown[]) => unknown,
  ): this {
    const fn = typeof optionsOrFn === "function" ? optionsOrFn : maybeFn;
    const options = typeof optionsOrFn === "function" ? {} : optionsOrFn;
    if (!fn || !this.conn.createFunction) throw new Error("UDF_UNSUPPORTED");
    this.conn.createFunction(name, Boolean(options.deterministic), fn);
    return this;
  }

  aggregate<T = unknown>(name: string, options: AggregateOptions<T>): this {
    if (!this.conn.createAggregate) throw new Error("UDF_UNSUPPORTED");
    const { start, step, result } = options;
    this.conn.createAggregate(name, {
      start: () => (typeof start === "function" ? (start as () => T)() : (start as T)),
      step: (acc, ...args) => {
        const next = step(acc as T, ...args);
        return next === undefined ? acc : next;
      },
      result: (acc) => (result ? result(acc as T) : acc),
    });
    return this;
  }

  transaction<A extends unknown[], R>(fn: (...args: A) => R): (...args: A) => R {
    return (...args: A): R => {
      this.exec("BEGIN IMMEDIATE");
      try {
        const result = fn(...args);
        this.exec("COMMIT");
        return result;
      } catch (error) {
        if (this.inTransaction) this.exec("ROLLBACK");
        throw error;
      }
    };
  }

  close(): this {
    if (this.open) {
      this.conn.close();
      this.open = false;
    }
    return this;
  }

  destroy(): void {
    if (this.conn.delete) {
      this.conn.delete();
      this.open = false;
    } else {
      this.close();
    }
  }
}

export function openShimDatabase(options: ShimOpenOptions): ShimDatabase {
  const conn =
    options.connection ??
    (open({
      name: options.name,
      ...(options.encryptionKey ? { encryptionKey: options.encryptionKey } : {}),
    }) as unknown as OpConnection);
  return new ShimDatabaseImpl(conn);
}

/** `new Database(path)` as the desktop connection code calls it; the path is the op-sqlite file name. */
export default class Database {
  constructor(name: string) {
    return openShimDatabase({ name }) as unknown as Database;
  }
}
