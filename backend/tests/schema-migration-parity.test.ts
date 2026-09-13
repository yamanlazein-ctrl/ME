import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { readMigrationFiles } from "drizzle-orm/migrator";

/**
 * ORM-schema ↔ migration parity guard.
 *
 * The defect this locks down (found while verifying the sync/restore work):
 * `fabrics.version` and `colors.version` were declared in the Drizzle schemas
 * and used by the repositories (`INSERT ... RETURNING version`,
 * `UPDATE ... WHERE version = $n`), but NO migration ever created the column. On
 * any database built from the migrations, every fabric/color create failed with
 * Postgres 42703 — reproduced live as `POST /api/inventory/fabrics -> 422`
 * ("فشل إنشاء القماش"), which in turn broke invoice creation and the F-07 sync
 * drills that build a stock chain first.
 *
 * The invariant: every column a schema declares must be created by some
 * migration, otherwise `npm run db:migrate` produces a database the code cannot
 * use. This is a text-level check (no database needed) so it fails fast in CI.
 */
const HERE = path.dirname(fileURLToPath(import.meta.url));
const BACKEND = path.join(HERE, "..");
const MIGRATIONS_DIR = path.join(BACKEND, "src", "infrastructure", "orm", "migrations");
const SCHEMAS_DIR = path.join(BACKEND, "src", "infrastructure", "orm", "schemas");

const PG_COLUMN_TYPES = [
  "uuid",
  "varchar",
  "text",
  "integer",
  "bigint",
  "smallint",
  "boolean",
  "timestamp",
  "date",
  "jsonb",
  "json",
  "decimal",
  "numeric",
  "real",
  "doublePrecision",
  "bigserial",
  "serial",
  "inet",
  "char",
];

/**
 * All migration SQL, split into statements. Splitting must respect SQL quoting:
 * a naive `split(";")` breaks inside string literals (e.g. 0014 declares
 * `DEFAULT 'application/json; charset=utf-8'`) and inside `$$`-quoted function
 * bodies, which would scatter one statement's columns across several chunks.
 */
function allMigrationStatements(): string[] {
  const out: string[] = [];
  for (const m of readMigrationFiles({ migrationsFolder: MIGRATIONS_DIR })) {
    const raw = m.sql.join("\n").replace(/-->\s*statement-breakpoint/g, "");
    let current = "";
    let inSingle = false;
    let dollarTag: string | null = null;
    let inLineComment = false;
    for (let i = 0; i < raw.length; i++) {
      const ch = raw[i];
      const rest = raw.slice(i);
      if (inLineComment) {
        // Comments are dropped from the matched text: a header like
        // "-- migration v2, see version notes" must not make an unrelated
        // `CREATE TABLE colors` look like it declares a `version` column.
        if (ch === "\n") {
          inLineComment = false;
          current += ch;
        }
        continue;
      }
      if (dollarTag) {
        if (rest.startsWith(dollarTag)) {
          current += dollarTag;
          i += dollarTag.length - 1;
          dollarTag = null;
          continue;
        }
        current += ch;
        continue;
      }
      if (inSingle) {
        current += ch;
        if (ch === "'") {
          if (raw[i + 1] === "'") {
            current += "'";
            i++;
          } else inSingle = false;
        }
        continue;
      }
      if (rest.startsWith("--")) {
        inLineComment = true;
        current += "--";
        i++;
        continue;
      }
      if (ch === "'") {
        inSingle = true;
        current += ch;
        continue;
      }
      const dollar = /^\$[A-Za-z_]*\$/.exec(rest);
      if (dollar) {
        dollarTag = dollar[0];
        current += dollarTag;
        i += dollarTag.length - 1;
        continue;
      }
      if (ch === ";") {
        out.push(current.trim());
        current = "";
        continue;
      }
      current += ch;
    }
    out.push(current.trim());
  }
  return out.filter(Boolean);
}

/** (table, column) pairs declared by the ORM schemas. */
function declaredColumns(): Array<{ table: string; column: string; file: string }> {
  const out: Array<{ table: string; column: string; file: string }> = [];
  const typeAlt = PG_COLUMN_TYPES.join("|");
  for (const f of fs.readdirSync(SCHEMAS_DIR)) {
    if (!f.endsWith(".table.ts")) continue;
    const src = fs.readFileSync(path.join(SCHEMAS_DIR, f), "utf8");
    // Attribute columns only to the pgTable block they appear in.
    const blocks = [...src.matchAll(/pgTable\(\s*"([a-z_]+)"\s*,\s*\{/g)];
    blocks.forEach((block, i) => {
      const start = block.index;
      const end = i + 1 < blocks.length ? blocks[i + 1].index : src.length;
      const body = src.slice(start, end);
      const re = new RegExp(`(?:\\w+):\\s*(?:${typeAlt})\\(\\s*"([a-z_]+)"`, "g");
      for (const m of body.matchAll(re)) out.push({ table: block[1], column: m[1], file: f });
    });
  }
  return out;
}

describe("ORM schema ↔ migrations parity", () => {
  const statements = allMigrationStatements();
  const columns = declaredColumns();

  /**
   * True when a migration STATEMENT declares the column FOR that table: either
   * its `CREATE TABLE <table>` lists the column, or an `ALTER TABLE <table>`
   * adds it. Matching the DDL target (not merely co-occurrence) matters —
   * `rolls` declares `version` in the same statement that has
   * `REFERENCES colors(id)`, so a looser check would claim `colors.version`
   * exists and miss the real drift.
   */
  function migrationCreates(table: string, column: string): boolean {
    const qualified = `(?:"?[a-z_]+"?\\s*\\.\\s*)?"?${table}"?`;
    const createRe = new RegExp(`CREATE\\s+TABLE\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?${qualified}`, "i");
    const alterRe = new RegExp(
      `ALTER\\s+TABLE\\s+(?:IF\\s+EXISTS\\s+)?(?:ONLY\\s+)?${qualified}`,
      "i",
    );
    const colRe = new RegExp(`\\b"?${column}"?\\b`);
    return statements.some((s) => (createRe.test(s) || alterRe.test(s)) && colRe.test(s));
  }

  it("finds a plausible schema inventory", () => {
    expect(columns.length).toBeGreaterThan(200);
  });

  it("every declared column is created by some migration", () => {
    const missing = columns.filter((c) => !migrationCreates(c.table, c.column));
    const unique = [...new Set(missing.map((c) => `${c.table}.${c.column} (${c.file})`))];
    expect(
      unique,
      `columns declared in the ORM schema but created by no migration — a migrated database will fail at runtime:\n${unique.join("\n")}`,
    ).toEqual([]);
  });
});
