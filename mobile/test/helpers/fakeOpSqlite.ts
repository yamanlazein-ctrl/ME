// Test-only: an op-sqlite-shaped connection over real better-sqlite3, to exercise BetterSqliteShim under Node.
import { createRequire } from "node:module";
import path from "node:path";
import type { OpConnection } from "../../src/platform/sqlite/BetterSqliteShim";

const requireFromBackend = createRequire(path.resolve(__dirname, "../../../backend/package.json"));
const BetterSqlite3 = requireFromBackend("better-sqlite3") as new (file: string) => {
  prepare(sql: string): {
    reader: boolean;
    run(...p: unknown[]): { changes: number; lastInsertRowid: number | bigint };
    all(...p: unknown[]): unknown[];
    raw(): { all(...p: unknown[]): unknown[]; columns?: never };
    columns(): Array<{ name: string }>;
  };
  function(name: string, options: object, fn: (...args: unknown[]) => unknown): void;
  aggregate(name: string, options: object): void;
  close(): void;
};

export function fakeOpConnection(file: string): OpConnection {
  const db = new BetterSqlite3(file);
  const bind = (params?: unknown[]) =>
    (params ?? []).map((p) => (p instanceof ArrayBuffer ? Buffer.from(p) : p));
  return {
    executeSync(query, params) {
      const stmt = db.prepare(query);
      if (stmt.reader) {
        const rows = stmt.all(...bind(params)) as Array<Record<string, never>>;
        return { rows, rowsAffected: 0 };
      }
      const r = stmt.run(...bind(params));
      return { rows: [], rowsAffected: r.changes, insertId: Number(r.lastInsertRowid) };
    },
    executeRawSync(query, params) {
      const stmt = db.prepare(query);
      if (stmt.reader) {
        const columnNames = stmt.columns().map((c) => c.name);
        const rawRows = stmt.raw().all(...bind(params)) as never[][];
        return { rawRows, columnNames, rowsAffected: 0 };
      }
      const r = stmt.run(...bind(params));
      return {
        rawRows: [],
        columnNames: [],
        rowsAffected: r.changes,
        insertId: Number(r.lastInsertRowid),
      };
    },
    createFunction(name, deterministic, fn) {
      db.function(name, { deterministic, safeIntegers: true, varargs: true }, fn);
    },
    createAggregate(name, spec) {
      db.aggregate(name, {
        start: spec.start,
        step: (acc: unknown, ...args: unknown[]) => spec.step(acc, ...args),
        result: spec.result,
        safeIntegers: true,
        deterministic: true,
        varargs: true,
      });
    },
    close: () => db.close(),
  };
}
