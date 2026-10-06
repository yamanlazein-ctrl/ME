/**
 * Exact int64 reads for better-sqlite3 (specs/001-desktop-sqlite-engine T032/T041).
 *
 * By default better-sqlite3 returns every INTEGER as a JS double, so a scaled
 * numeric(18,6) value above 2^53 (|v| > ~9.007e9) loses its last digits before
 * the column type sees it. With this wrapper every statement runs in
 * safe-integer mode and each result value is then normalized:
 *   - integers inside ±2^53 → plain `number` (exactly what the default mode gives);
 *   - integers outside → `bigint`, which the scaled column types read exactly.
 * Nothing else changes, so code reading counts, ids and amounts sees numbers as before.
 * Errors are converted to PostgreSQL's shape here (errors.ts, T044) — the one choke point
 * every statement passes through.
 */
import type Database from "better-sqlite3";
import { mapSqliteError } from "./errors.js";

const MIN = BigInt(Number.MIN_SAFE_INTEGER);
const MAX = BigInt(Number.MAX_SAFE_INTEGER);

function normalizeValue(v: unknown): unknown {
  return typeof v === "bigint" && v >= MIN && v <= MAX ? Number(v) : v;
}

function normalizeRow(row: unknown): unknown {
  if (Array.isArray(row)) {
    for (let i = 0; i < row.length; i++) row[i] = normalizeValue(row[i]);
    return row;
  }
  if (row && typeof row === "object") {
    const r = row as Record<string, unknown>;
    for (const k in r) r[k] = normalizeValue(r[k]);
    return r;
  }
  return normalizeValue(row);
}

const CHAINING = new Set(["raw", "pluck", "expand", "bind", "safeIntegers"]);

function wrapStatement(db: Database.Database, stmt: Database.Statement): Database.Statement {
  stmt.safeIntegers(true);
  const guard = <R>(args: unknown[], run: () => R): R => {
    try {
      return run();
    } catch (e) {
      throw mapSqliteError(e, db, stmt, args);
    }
  };
  const proxy: Database.Statement = new Proxy(stmt, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (typeof value !== "function") return value;
      if (prop === "all") return (...a: unknown[]) => guard(a, () => (target.all(...a) as unknown[]).map(normalizeRow));
      if (prop === "get") return (...a: unknown[]) => guard(a, () => normalizeRow(target.get(...a)));
      if (prop === "iterate") {
        return function* (...a: unknown[]) {
          const it = guard(a, () => target.iterate(...a));
          while (true) {
            const n = guard(a, () => it.next());
            if (n.done) return;
            yield normalizeRow(n.value);
          }
        };
      }
      if (prop === "run") {
        return (...a: unknown[]) => {
          const r = guard(a, () => target.run(...a));
          return { changes: r.changes, lastInsertRowid: normalizeValue(r.lastInsertRowid) };
        };
      }
      if (typeof prop === "string" && CHAINING.has(prop)) {
        return (...a: unknown[]) => {
          (value as (...x: unknown[]) => unknown).apply(target, a);
          if (prop === "safeIntegers") target.safeIntegers(true); // stays exact
          return proxy;
        };
      }
      void receiver;
      return (value as (...x: unknown[]) => unknown).bind(target);
    },
  });
  return proxy;
}

/** A view of `db` whose prepared statements read int64 values exactly (see module doc). */
export function withExactIntegers(db: Database.Database): Database.Database {
  return new Proxy(db, {
    get(target, prop) {
      const value = Reflect.get(target, prop, target) as unknown;
      if (prop === "prepare") {
        return (source: string) => {
          try {
            return wrapStatement(target, target.prepare(source));
          } catch (e) {
            throw mapSqliteError(e, target);
          }
        };
      }
      return typeof value === "function" ? (value as (...x: unknown[]) => unknown).bind(target) : value;
    },
  });
}
