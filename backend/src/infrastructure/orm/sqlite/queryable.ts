/**
 * `pool.query(text, values)`-shaped adapter over the SQLite reader (specs/001-desktop-sqlite-engine),
 * for engine-neutral helpers that only need "run this read and give me rows" — e.g. the boot-time
 * integrity manifest. `$n` placeholders are rewritten to positional `?` (repeats allowed). The SQL
 * text itself must already be SQLite-compatible.
 */
import { getSqliteRuntime } from "./runtime.js";

export interface RowsQueryable {
  query<R = Record<string, unknown>>(text: string, values?: unknown[]): Promise<{ rows: R[] }>;
}

export function sqliteReaderQueryable(): RowsQueryable {
  return {
    async query<R = Record<string, unknown>>(text: string, values: unknown[] = []) {
      const rt = getSqliteRuntime();
      if (!rt) throw new Error("SQLITE_NOT_INITIALIZED: boot the SQLite runtime first");
      const params: unknown[] = [];
      const sql = text.replace(/\$(\d+)/g, (_, n: string) => {
        params.push(values[Number(n) - 1]);
        return "?";
      });
      return { rows: rt.conns.reader.prepare(sql).all(...params) as R[] };
    },
  };
}
