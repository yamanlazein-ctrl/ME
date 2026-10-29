// Phone copy of the read/diff half of backend/src/infrastructure/orm/sqlite/schemaFingerprint.ts. The
// backend file also reads the migrations folder with node:fs, which the import boundary forbids, so the
// pure part is repeated here. test/unit/runtime-node.test.ts proves it yields the committed fingerprint.
import type { ShimDatabase } from "../platform/sqlite/types";

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
  tables: Record<
    string,
    { columns: Record<string, { type: string; nullable: boolean; default: string | null }> }
  >;
  constraints: Record<string, SqliteConstraint>;
  indexes: Record<string, { table: string; definition: string }>;
  triggers: Record<string, { table: string; definition: string }>;
}

const unq = (s: string) => s.trim().replace(/^"|"$/g, "");
const list = (s: string) => s.split(",").map(unq);

export function readSqliteFingerprint(db: ShimDatabase, journalIdx: number): SqliteFingerprint {
  const fp: SqliteFingerprint = {
    journalIdx,
    engine: "sqlite",
    tables: {},
    constraints: {},
    indexes: {},
    triggers: {},
  };
  const tables = db
    .prepare(
      "SELECT name, sql FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    )
    .all() as Array<{ name: string; sql: string }>;
  for (const { name: t, sql } of tables) {
    const columns: SqliteFingerprint["tables"][string]["columns"] = {};
    const cols = db.prepare("SELECT * FROM pragma_table_xinfo(?) ORDER BY cid").all(t) as Array<{
      name: string;
      type: string;
      notnull: number;
      pk: number;
      dflt_value: string | null;
    }>;
    for (const c of cols) {
      columns[c.name] = { type: c.type, nullable: !c.notnull && !c.pk, default: c.dflt_value };
    }
    fp.tables[t] = { columns };
    const body = sql.slice(sql.indexOf("(") + 1, sql.lastIndexOf(")"));
    let fkSeen = 0;
    for (const m of body.matchAll(/^\s*"([^"]+)"\s+\w+\s+CONSTRAINT\s+"([^"]+)"\s+PRIMARY KEY/gm)) {
      fp.constraints[m[2] as string] = {
        table: t,
        type: "p",
        columns: [m[1] as string],
        definition: m[0].trim(),
      };
    }
    for (const m of body.matchAll(
      /^\s*CONSTRAINT\s+"([^"]+)"\s+(PRIMARY KEY|UNIQUE|CHECK|FOREIGN KEY)\s*(.*?),?\s*$/gm,
    )) {
      const cname = m[1] as string;
      const kind = m[2] as string;
      const rest = m[3] as string;
      const definition = `${kind} ${rest}`;
      if (kind === "PRIMARY KEY" || kind === "UNIQUE") {
        fp.constraints[cname] = {
          table: t,
          type: kind === "UNIQUE" ? "u" : "p",
          columns: list(/^\(([^)]*)\)/.exec(rest)?.[1] ?? ""),
          definition,
        };
      } else if (kind === "CHECK") {
        fp.constraints[cname] = { table: t, type: "c", definition };
      } else {
        const f =
          /^\(([^)]*)\)\s+REFERENCES\s+"([^"]+)"\s+\(([^)]*)\)(?:\s+ON DELETE\s+(SET NULL|CASCADE|RESTRICT|SET DEFAULT|NO ACTION))?/.exec(
            rest,
          );
        if (!f) throw new Error(`unparsed FK ${cname}: ${rest}`);
        fp.constraints[cname] = {
          table: t,
          type: "f",
          columns: list(f[1] as string),
          refTable: f[2] as string,
          refColumns: list(f[3] as string),
          onDelete: (f[4] ?? "NO ACTION").toLowerCase(),
          definition,
        };
        fkSeen++;
      }
    }
    const fkIds = new Set(
      (db.prepare("SELECT id FROM pragma_foreign_key_list(?)").all(t) as Array<{ id: number }>).map(
        (r) => r.id,
      ),
    );
    if (fkIds.size !== fkSeen) {
      throw new Error(`${t}: ${fkIds.size} FKs in PRAGMA but ${fkSeen} named in the DDL`);
    }
  }
  for (const r of db
    .prepare(
      "SELECT name, tbl_name, sql FROM sqlite_schema WHERE type = 'index' AND sql IS NOT NULL ORDER BY name",
    )
    .all() as Array<{ name: string; tbl_name: string; sql: string }>) {
    fp.indexes[r.name] = { table: r.tbl_name, definition: r.sql };
  }
  for (const r of db
    .prepare("SELECT name, tbl_name, sql FROM sqlite_schema WHERE type = 'trigger' ORDER BY name")
    .all() as Array<{ name: string; tbl_name: string; sql: string }>) {
    fp.triggers[r.name] = { table: r.tbl_name, definition: r.sql };
  }
  return fp;
}

/** Structural differences between two fingerprints (journalIdx excluded). Empty = identical. */
export function diffSqliteFingerprint(
  expected: SqliteFingerprint,
  live: SqliteFingerprint,
): string[] {
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
