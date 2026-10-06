/**
 * SQLite schema fingerprint (specs/001-desktop-sqlite-engine T038/T045), in the JSON shape
 * that scripts/compare-schema-fingerprints.mjs reads:
 *
 *   tables.{t}.columns.{c} = { type, nullable, default }
 *   constraints.{name}     = { table, type: "p"|"u"|"c"|"f", columns?, refTable?, refColumns?, onDelete?, definition }
 *   indexes.{name}         = { table, definition }
 *   triggers.{name}        = { table, definition }
 *
 * Constraint names come from the stored CREATE TABLE text (SQLite keeps it verbatim); FK
 * counts are cross-checked against PRAGMA foreign_key_list. Used by the generator script and,
 * at desktop boot, to verify the live file against the committed fingerprint.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type Database from "better-sqlite3";

export interface SqliteConstraint {
  table: string;
  type: "p" | "u" | "c" | "f";
  columns?: string[];
  refTable?: string;
  refColumns?: string[];
  onDelete?: string;
  definition: string;
}

export interface SqliteFingerprint {
  journalIdx: number;
  engine: "sqlite";
  tables: Record<string, { columns: Record<string, { type: string; nullable: boolean; default: string | null }> }>;
  constraints: Record<string, SqliteConstraint>;
  indexes: Record<string, { table: string; definition: string }>;
  triggers: Record<string, { table: string; definition: string }>;
}

const unq = (s: string) => s.trim().replace(/^"|"$/g, "");
const list = (s: string) => s.split(",").map(unq);

export function readSqliteFingerprint(db: Database.Database, journalIdx: number): SqliteFingerprint {
  const fp: SqliteFingerprint = { journalIdx, engine: "sqlite", tables: {}, constraints: {}, indexes: {}, triggers: {} };
  const tables = db
    .prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all() as Array<{ name: string; sql: string }>;
  for (const { name: t, sql } of tables) {
    const columns: SqliteFingerprint["tables"][string]["columns"] = {};
    const cols = db.prepare("SELECT * FROM pragma_table_xinfo(?) ORDER BY cid").all(t) as Array<{
      name: string; type: string; notnull: number; pk: number; dflt_value: string | null;
    }>;
    for (const c of cols) columns[c.name] = { type: c.type, nullable: !c.notnull && !c.pk, default: c.dflt_value };
    fp.tables[t] = { columns };
    const body = sql.slice(sql.indexOf("(") + 1, sql.lastIndexOf(")"));
    let fkSeen = 0;
    for (const m of body.matchAll(/^\s*"([^"]+)"\s+\w+\s+CONSTRAINT\s+"([^"]+)"\s+PRIMARY KEY/gm)) {
      fp.constraints[m[2]] = { table: t, type: "p", columns: [m[1]], definition: m[0].trim() };
    }
    for (const m of body.matchAll(/^\s*CONSTRAINT\s+"([^"]+)"\s+(PRIMARY KEY|UNIQUE|CHECK|FOREIGN KEY)\s*(.*?),?\s*$/gm)) {
      const [, cname, kind, rest] = m;
      const definition = `${kind} ${rest}`;
      if (kind === "PRIMARY KEY" || kind === "UNIQUE") {
        fp.constraints[cname] = { table: t, type: kind === "UNIQUE" ? "u" : "p", columns: list(/^\(([^)]*)\)/.exec(rest)![1]), definition };
      } else if (kind === "CHECK") {
        fp.constraints[cname] = { table: t, type: "c", definition };
      } else {
        const f = /^\(([^)]*)\)\s+REFERENCES\s+"([^"]+)"\s+\(([^)]*)\)(?:\s+ON DELETE\s+(SET NULL|CASCADE|RESTRICT|SET DEFAULT|NO ACTION))?/.exec(rest);
        if (!f) throw new Error(`unparsed FK ${cname}: ${rest}`);
        fp.constraints[cname] = {
          table: t, type: "f", columns: list(f[1]), refTable: f[2], refColumns: list(f[3]),
          onDelete: (f[4] ?? "NO ACTION").toLowerCase(), definition,
        };
        fkSeen++;
      }
    }
    const fkIds = new Set((db.prepare("SELECT id FROM pragma_foreign_key_list(?)").all(t) as Array<{ id: number }>).map((r) => r.id));
    if (fkIds.size !== fkSeen) throw new Error(`${t}: ${fkIds.size} FKs in PRAGMA but ${fkSeen} named in the DDL`);
  }
  for (const r of db.prepare("SELECT name, tbl_name, sql FROM sqlite_schema WHERE type = 'index' AND sql IS NOT NULL ORDER BY name").all() as Array<{ name: string; tbl_name: string; sql: string }>) {
    fp.indexes[r.name] = { table: r.tbl_name, definition: r.sql };
  }
  for (const r of db.prepare("SELECT name, tbl_name, sql FROM sqlite_schema WHERE type = 'trigger' ORDER BY name").all() as Array<{ name: string; tbl_name: string; sql: string }>) {
    fp.triggers[r.name] = { table: r.tbl_name, definition: r.sql };
  }
  return fp;
}

/** Structural differences between two fingerprints (journalIdx excluded). Empty = identical. */
export function diffSqliteFingerprint(expected: SqliteFingerprint, live: SqliteFingerprint): string[] {
  const out: string[] = [];
  for (const section of ["tables", "constraints", "indexes", "triggers"] as const) {
    const e = expected[section] as Record<string, unknown>;
    const l = live[section] as Record<string, unknown>;
    for (const k of Object.keys(e)) {
      if (!(k in l)) out.push(`${section}.${k}: missing`);
      else if (JSON.stringify(e[k]) !== JSON.stringify(l[k])) out.push(`${section}.${k}: changed`);
    }
    for (const k of Object.keys(l)) if (!(k in e)) out.push(`${section}.${k}: extra`);
  }
  return out;
}

export interface SqliteJournal {
  entries: Array<{ idx: number; tag: string }>;
}

export function loadSqliteJournal(migrationsDir: string): SqliteJournal {
  return JSON.parse(readFileSync(join(migrationsDir, "meta", "_journal.json"), "utf8")) as SqliteJournal;
}

export function loadCommittedSqliteFingerprint(migrationsDir: string): SqliteFingerprint {
  return JSON.parse(readFileSync(join(migrationsDir, "meta", "schema-fingerprint.json"), "utf8")) as SqliteFingerprint;
}
