/**
 * SQLite → PostgreSQL error shape (specs/001-desktop-sqlite-engine T044).
 *
 * Every consumer of persistence errors (persistenceErrorMessage, returnUseCases, the licence
 * provider…) reads PG's SQLSTATE `code`, the `constraint` name and PG's message text. Errors
 * raised by better-sqlite3 are converted here, at the statement wrapper, into an Error with
 * exactly those fields (original kept as `cause`), so user-facing text is identical on both
 * engines without touching any consumer.
 *
 * FK failures: SQLite does not name the violated constraint. The statement is replayed inside a
 * savepoint with deferred FKs, `PRAGMA foreign_key_check` names the violated FK, and the savepoint
 * is rolled back — so the PG constraint name is reported, as PG does.
 */
import type Database from "better-sqlite3";
import { SqliteValueError } from "./types.js";

export class PgShapedError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly constraint?: string,
    readonly table?: string,
    readonly column?: string,
    cause?: unknown,
  ) {
    super(message, { cause });
    this.name = "PgShapedError";
  }
}

interface SchemaIndex {
  /** "table|col1,col2" → constraint or unique-index name (PG name). */
  unique: Map<string, string>;
  /** constraint name → table */
  tableOf: Map<string, string>;
  /** "table|cols|refTable" → FK name */
  fk: Map<string, string>;
}

const cache = new WeakMap<Database.Database, SchemaIndex>();

function schemaIndex(db: Database.Database): SchemaIndex {
  const hit = cache.get(db);
  if (hit) return hit;
  const ix: SchemaIndex = { unique: new Map(), tableOf: new Map(), fk: new Map() };
  const tables = db.prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all() as Array<{ name: string; sql: string }>;
  const unq = (s: string) => s.split(",").map((c) => c.trim().replace(/^"|"$/g, "").split(/\s+/)[0]);
  for (const { name: t, sql } of tables) {
    for (const m of sql.matchAll(/CONSTRAINT\s+"([^"]+)"\s+(PRIMARY KEY|UNIQUE|CHECK|FOREIGN KEY)\s*\(([^)]*)\)(?:\s+REFERENCES\s+"([^"]+)")?/g)) {
      const [, name, kind, cols, ref] = m;
      ix.tableOf.set(name, t);
      if (kind === "PRIMARY KEY" || kind === "UNIQUE") ix.unique.set(`${t}|${unq(cols).join(",")}`, name);
      if (kind === "FOREIGN KEY") ix.fk.set(`${t}|${unq(cols).join(",")}|${ref}`, name);
    }
    for (const m of sql.matchAll(/^\s*"([^"]+)"\s+\w+\s+CONSTRAINT\s+"([^"]+)"\s+PRIMARY KEY/gm)) {
      ix.unique.set(`${t}|${m[1]}`, m[2]);
      ix.tableOf.set(m[2], t);
    }
  }
  const idx = db.prepare("SELECT name, tbl_name, sql FROM sqlite_schema WHERE type = 'index' AND sql LIKE 'CREATE UNIQUE INDEX%'").all() as Array<{ name: string; tbl_name: string; sql: string }>;
  for (const r of idx) {
    const cols = /\(([^)]*)\)/.exec(r.sql)?.[1] ?? "";
    const key = `${r.tbl_name}|${unq(cols).join(",")}`;
    if (!ix.unique.has(key)) ix.unique.set(key, r.name);
    ix.tableOf.set(r.name, r.tbl_name);
  }
  cache.set(db, ix);
  return ix;
}

const TRIGGER_GUARDS = /^(ledger_entries|license_audit_events)\b/;

/** Name the FK a failed statement violates, by replaying it with deferred FKs in a savepoint. */
function probeForeignKey(db: Database.Database, stmt: Database.Statement | undefined, args: unknown[]): { name?: string; table?: string } {
  if (!stmt || !db.inTransaction || stmt.reader) return {};
  try {
    db.exec("SAVEPOINT motard_fk_probe");
    try {
      db.pragma("defer_foreign_keys = ON");
      stmt.run(...args);
      const rows = db.pragma("foreign_key_check") as Array<{ table: string; fkid: number; parent: string }>;
      const first = rows[0];
      if (!first) return {};
      const fk = (db.prepare("SELECT * FROM pragma_foreign_key_list(?) WHERE id = ? ORDER BY seq").all(first.table, first.fkid) as Array<{ from: string; table: string }>);
      const cols = fk.map((r) => r.from).join(",");
      return { name: schemaIndex(db).fk.get(`${first.table}|${cols}|${first.parent}`), table: first.table };
    } finally {
      db.exec("ROLLBACK TO motard_fk_probe");
      db.exec("RELEASE motard_fk_probe");
      db.pragma("defer_foreign_keys = OFF");
    }
  } catch {
    return {};
  }
}

/** Convert a better-sqlite3 error into a PG-shaped error (non-SQLite errors pass through). */
export function mapSqliteError(e: unknown, db: Database.Database, stmt?: Database.Statement, args: unknown[] = []): unknown {
  if (e instanceof PgShapedError) return e;
  if (e instanceof SqliteValueError) return new PgShapedError(e.code, e.message, undefined, undefined, undefined, e);
  const err = e as { code?: unknown; message?: unknown };
  if (typeof err?.code !== "string" || !err.code.startsWith("SQLITE_")) return e;
  const msg = String(err.message ?? "");
  const code = err.code;

  if (code === "SQLITE_CONSTRAINT_UNIQUE" || code === "SQLITE_CONSTRAINT_PRIMARYKEY") {
    const m = /constraint failed: (.*)$/.exec(msg);
    const parts = (m?.[1] ?? "").split(",").map((p) => p.trim());
    const table = parts[0]?.split(".")[0] ?? "";
    const cols = parts.map((p) => p.split(".")[1]).join(",");
    const idxName = /index '([^']+)'/.exec(msg)?.[1];
    const name = idxName ?? schemaIndex(db).unique.get(`${table}|${cols}`) ?? `${table}_${cols.replace(/,/g, "_")}_key`;
    return new PgShapedError("23505", `duplicate key value violates unique constraint "${name}"`, name, table, undefined, e);
  }
  if (code === "SQLITE_CONSTRAINT_FOREIGNKEY") {
    const p = probeForeignKey(db, stmt, args);
    const name = p.name ?? "foreign_key";
    return new PgShapedError("23503", `insert or update on table "${p.table ?? "unknown"}" violates foreign key constraint "${name}"`, p.name, p.table, undefined, e);
  }
  if (code === "SQLITE_CONSTRAINT_NOTNULL") {
    const m = /constraint failed: ([^.]+)\.(.+)$/.exec(msg);
    return new PgShapedError("23502", `null value in column "${m?.[2]}" of relation "${m?.[1]}" violates not-null constraint`, undefined, m?.[1], m?.[2], e);
  }
  if (code === "SQLITE_CONSTRAINT_CHECK") {
    const name = /constraint failed: (.+)$/.exec(msg)?.[1]?.trim() ?? "";
    const g = /^ck_sqlite_([a-z]+)(?:_(\d+))?__([^_].*?)__(.+)$/.exec(name);
    if (g) {
      const [, kind, n, table, column] = g;
      if (kind === "len") return new PgShapedError("22001", `value too long for type character varying(${n})`, undefined, table, column, e);
      if (kind === "json") return new PgShapedError("22P02", "invalid input syntax for type json", undefined, table, column, e);
      if (kind === "bool") return new PgShapedError("22P02", "invalid input syntax for type boolean", undefined, table, column, e);
      if (kind === "arr") return new PgShapedError("22P02", "malformed array literal", undefined, table, column, e);
      if (kind === "date") return new PgShapedError("22008", "date/time field value out of range", undefined, table, column, e);
      if (kind === "ts") return new PgShapedError("22007", "invalid input syntax for type timestamp with time zone", undefined, table, column, e);
    }
    const table = schemaIndex(db).tableOf.get(name) ?? "";
    return new PgShapedError("23514", `new row for relation "${table}" violates check constraint "${name}"`, name, table, undefined, e);
  }
  if (code === "SQLITE_CONSTRAINT_TRIGGER" || TRIGGER_GUARDS.test(msg)) {
    // RAISE(ABORT, …) from the append-only guards: PG raises them as insufficient_privilege.
    return new PgShapedError("42501", msg, undefined, undefined, undefined, e);
  }
  if (code === "SQLITE_CONSTRAINT_DATATYPE" || code === "SQLITE_MISMATCH") {
    return new PgShapedError("22P02", `invalid input syntax: ${msg}`, undefined, undefined, undefined, e);
  }
  if (code === "SQLITE_FULL") return new PgShapedError("53100", "could not extend file: No space left on device", undefined, undefined, undefined, e);
  if (code === "SQLITE_READONLY" || code.startsWith("SQLITE_READONLY_")) {
    return new PgShapedError("25006", "cannot execute statement in a read-only transaction", undefined, undefined, undefined, e);
  }
  if (code === "SQLITE_BUSY" || code.startsWith("SQLITE_BUSY_") || code === "SQLITE_LOCKED") {
    return new PgShapedError("55P03", "could not obtain lock", undefined, undefined, undefined, e);
  }
  if (code === "SQLITE_CORRUPT" || code.startsWith("SQLITE_CORRUPT_") || code === "SQLITE_NOTADB") {
    return new PgShapedError("XX001", `database file is corrupt: ${msg}`, undefined, undefined, undefined, e);
  }
  if (code === "SQLITE_IOERR" || code.startsWith("SQLITE_IOERR_")) {
    return new PgShapedError("58030", `I/O error: ${msg}`, undefined, undefined, undefined, e);
  }
  return e;
}
