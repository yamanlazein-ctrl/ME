/**
 * Generate the desktop SQLite Drizzle table definitions (specs/001-desktop-sqlite-engine T034).
 *
 *   npx tsx scripts/generate-sqlite-schema.mts [--check]
 *
 * Source of truth:
 *   - the PG Drizzle schema (`src/infrastructure/orm/schemas/*.table.ts`): TS export names,
 *     TS property keys, column order, read modes (numeric number/string), enums, `$type<>`;
 *   - the live schema fingerprint (`migrations/meta/schema-fingerprint.json`, journal 99):
 *     column types (precision/scale), nullability, defaults and primary keys.
 * Output: `src/infrastructure/orm/sqlite/schemas/<same-name>.table.ts` + `index.ts`, plus the three
 * raw-SQL-only live tables (`financial_operations`, `sync_conflicts`, `sync_tombstones`).
 *
 * A Drizzle definition carries exactly the PG Drizzle columns, so `select()` shapes are identical
 * on both engines; live-only columns (e.g. `sync_inbox.tombstone_id`) exist only in the DDL
 * (0000_baseline.sql, T036), where SQLite applies their DEFAULT. Every live default is carried into
 * the definition, because Drizzle's SQLite dialect binds NULL for an omitted column that has none.
 * `--check` fails if the committed files differ from a fresh generation.
 */
import { readFileSync, readdirSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { getTableColumns, getTableName, is } from "drizzle-orm";
import { PgTable } from "drizzle-orm/pg-core";

const here = dirname(fileURLToPath(import.meta.url));
const PG_DIR = join(here, "../src/infrastructure/orm/schemas");
const OUT_DIR = join(here, "../src/infrastructure/orm/sqlite/schemas");
const FP = JSON.parse(readFileSync(join(here, "../src/infrastructure/orm/migrations/meta/schema-fingerprint.json"), "utf8")) as {
  tables: Record<string, { columns: Record<string, { type: string; nullable: boolean; default: string | null }> }>;
  constraints: Record<string, { table: string; type: string; definition: string }>;
};
const RAW_ONLY: Record<string, { file: string; exportName: string }> = {
  financial_operations: { file: "financial-operation.table.ts", exportName: "financialOperations" },
  sync_conflicts: { file: "sync-conflict.table.ts", exportName: "syncConflicts" },
  sync_tombstones: { file: "sync-tombstone.table.ts", exportName: "syncTombstones" },
};
const check = process.argv.includes("--check");

type Col = {
  key: string;
  name: string;
  pgClass: string;
  baseClass?: string;
  enumValues?: string[];
  tsType?: string;
};

const camel = (s: string) => s.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());

function primaryKeyOf(table: string): string[] {
  const pk = Object.values(FP.constraints).find((c) => c.table === table && c.type === "p");
  if (!pk) throw new Error(`no primary key for ${table}`);
  return /\(([^)]*)\)/.exec(pk.definition)![1].split(",").map((s) => s.trim());
}

/** Class the column is generated from: the PG Drizzle class, or one inferred from the live type. */
function classFromLive(type: string): Pick<Col, "pgClass" | "baseClass"> {
  if (type === "uuid") return { pgClass: "PgUUID" };
  if (type.startsWith("character varying")) return { pgClass: "PgVarchar" };
  if (type === "text") return { pgClass: "PgText" };
  if (type === "timestamp with time zone") return { pgClass: "PgTimestamp" };
  if (type === "integer") return { pgClass: "PgInteger" };
  if (type === "bigint") return { pgClass: "PgBigInt53" };
  if (type === "jsonb") return { pgClass: "PgJsonb" };
  if (type === "boolean") return { pgClass: "PgBoolean" };
  if (type === "date") return { pgClass: "PgDateString" };
  if (type.startsWith("numeric(")) return { pgClass: "PgNumericNumber" };
  if (type === "text[]") return { pgClass: "PgArray", baseClass: "PgText" };
  if (type === "uuid[]") return { pgClass: "PgArray", baseClass: "PgUUID" };
  throw new Error(`unmapped live type ${type}`);
}

function parseDefault(table: string, col: Col, liveType: string, def: string, isPk: boolean): string {
  if (def === "now()") return ".$defaultFn(nowDefault)";
  if (def === "gen_random_uuid()" || def === "uuid_generate_v4()") return ".$defaultFn(randomUuid)";
  const seq = /^nextval\('([a-z_]+)'::regclass\)$/.exec(def);
  if (seq) return isPk ? "" : `.$defaultFn(() => nextSequenceValue(${JSON.stringify(seq[1])}))`;
  if (def === "true" || def === "false") return `.default(${def})`;
  if (/^-?\d+(\.\d+)?$/.test(def)) {
    return col.pgClass === "PgNumeric" ? `.default(${JSON.stringify(def)})` : `.default(${def})`;
  }
  const str = /^'((?:[^']|'')*)'::(character varying|text)$/.exec(def);
  if (str) return `.default(${JSON.stringify(str[1].replace(/''/g, "'"))})`;
  const json = /^'((?:[^']|'')*)'::jsonb$/.exec(def);
  if (json) return `.default(${JSON.stringify(JSON.parse(json[1].replace(/''/g, "'")))})`;
  if (/^'\{\}'::(text|uuid)\[\]$/.test(def)) return ".default([])";
  throw new Error(`unmapped default ${table}.${col.name}: ${def} (${liveType})`);
}

function columnExpr(table: string, col: Col, pk: string[]): { expr: string; uses: Set<string> } {
  const live = FP.tables[table].columns[col.name];
  if (!live) throw new Error(`${table}.${col.name} is declared in Drizzle but not live`);
  const uses = new Set<string>();
  const isSolePk = pk.length === 1 && pk[0] === col.name;
  const serialPk = isSolePk && /^nextval\(/.test(live.default ?? "");
  let expr: string;
  switch (col.pgClass) {
    case "PgUUID":
      expr = `uuid(${JSON.stringify(col.name)})`;
      uses.add("uuid");
      break;
    case "PgVarchar":
    case "PgText":
      expr = col.enumValues?.length
        ? `text(${JSON.stringify(col.name)}, { enum: ${JSON.stringify(col.enumValues)} })`
        : `text(${JSON.stringify(col.name)})`;
      uses.add("text");
      break;
    case "PgTimestamp":
      expr = `timestamptz(${JSON.stringify(col.name)})`;
      uses.add("timestamptz");
      break;
    case "PgInteger":
    case "PgBigInt53":
    case "PgBigSerial53":
      expr = `integer(${JSON.stringify(col.name)}, { mode: "number" })`;
      uses.add("integer");
      break;
    case "PgJsonb":
      expr = `jsonb(${JSON.stringify(col.name)})`;
      uses.add("jsonb");
      break;
    case "PgBoolean":
      expr = `boolean(${JSON.stringify(col.name)})`;
      uses.add("boolean");
      break;
    case "PgDateString":
      expr = `date(${JSON.stringify(col.name)})`;
      uses.add("date");
      break;
    case "PgInet":
      expr = `inet(${JSON.stringify(col.name)})`;
      uses.add("inet");
      break;
    case "PgNumericNumber":
    case "PgNumeric": {
      const m = /^numeric\((\d+),(\d+)\)$/.exec(live.type);
      if (!m) throw new Error(`${table}.${col.name}: live type ${live.type} is not numeric(p,s)`);
      const fn = col.pgClass === "PgNumeric" ? "decimalString" : "numeric";
      expr = `${fn}(${JSON.stringify(col.name)}, { precision: ${m[1]}, scale: ${m[2]} })`;
      uses.add(fn);
      break;
    }
    case "PgArray": {
      const fn = col.baseClass === "PgUUID" ? "uuidArray" : "textArray";
      expr = `${fn}(${JSON.stringify(col.name)})`;
      uses.add(fn);
      break;
    }
    default:
      throw new Error(`unmapped Drizzle class ${col.pgClass} (${table}.${col.name})`);
  }
  if (!live.nullable && !serialPk) expr += ".notNull()";
  if (isSolePk) expr += serialPk ? ".primaryKey({ autoIncrement: true })" : ".primaryKey()";
  if (live.default !== null) {
    const d = parseDefault(table, col, live.type, live.default, isSolePk);
    expr += d;
    if (d.includes("nowDefault")) uses.add("nowDefault");
    if (d.includes("randomUuid")) uses.add("randomUuid");
    if (d.includes("nextSequenceValue")) uses.add("nextSequenceValue");
  }
  if (col.tsType) expr += `.$type<${col.tsType}>()`;
  return { expr, uses };
}

function tableSource(table: string, exportName: string, cols: Col[], uses: Set<string>): string {
  const pk = primaryKeyOf(table);
  const lines: string[] = [];
  for (const c of cols) {
    const { expr, uses: u } = columnExpr(table, c, pk);
    u.forEach((x) => uses.add(x));
    lines.push(`    ${c.key}: ${expr},`);
  }
  const composite = pk.length > 1;
  if (composite) uses.add("primaryKey");
  const keyOf = (name: string) => cols.find((c) => c.name === name)?.key ?? (() => { throw new Error(`${table}: PK column ${name} not declared`); })();
  const extra = composite ? `,\n  (t) => [primaryKey({ columns: [${pk.map((n) => `t.${keyOf(n)}`).join(", ")}] })]` : "";
  return `export const ${exportName} = sqliteTable(\n  ${JSON.stringify(table)},\n  {\n${lines.join("\n")}\n  }${extra},\n);\n`;
}

function header(uses: Set<string>): string {
  const core = ["sqliteTable", ...["integer", "text", "primaryKey"].filter((x) => uses.has(x))];
  const types = ["uuid", "timestamptz", "jsonb", "boolean", "date", "inet", "numeric", "decimalString", "textArray", "uuidArray", "nowDefault", "randomUuid"].filter((x) => uses.has(x));
  let h =
    "// GENERATED by scripts/generate-sqlite-schema.mts from the PG Drizzle schema and the live\n" +
    "// schema fingerprint (specs/001-desktop-sqlite-engine T034). Do not edit by hand.\n" +
    `import { ${core.join(", ")} } from "drizzle-orm/sqlite-core";\n`;
  if (types.length) h += `import { ${types.join(", ")} } from "../types.js";\n`;
  if (uses.has("nextSequenceValue")) h += `import { nextSequenceValue } from "../sequences.js";\n`;
  return h + "\n";
}

// ── collect PG Drizzle tables per file ──────────────────────────────────────
const files = readdirSync(PG_DIR).filter((f) => f.endsWith(".table.ts")).sort();
const outputs = new Map<string, string>();
const definedIn = new Map<string, { file: string; exportName: string }>();
const perFile: Array<{ file: string; tables: Array<{ name: string; exportName: string; cols: Col[] }>; aliases: Array<{ exportName: string; table: string }> }> = [];

for (const file of files) {
  const src = readFileSync(join(PG_DIR, file), "utf8");
  const defines = new Set([...src.matchAll(/pgTable\(\s*"([a-z_]+)"/g)].map((m) => m[1]));
  const mod = (await import(pathToFileURL(join(PG_DIR, file)).href)) as Record<string, unknown>;
  const entry = { file, tables: [] as Array<{ name: string; exportName: string; cols: Col[] }>, aliases: [] as Array<{ exportName: string; table: string }> };
  for (const [exportName, v] of Object.entries(mod)) {
    if (!is(v, PgTable)) continue;
    const name = getTableName(v);
    if (!defines.has(name)) {
      entry.aliases.push({ exportName, table: name });
      continue;
    }
    const cols: Col[] = Object.entries(getTableColumns(v)).map(([key, c]) => {
      const col = c as unknown as { name: string; columnType: string; baseColumn?: { columnType: string }; enumValues?: string[] };
      const tsType = new RegExp(`\\("${col.name}"[^\\n]*?\\.\\$type<(.+?)>\\(\\)`).exec(src)?.[1];
      return {
        key,
        name: col.name,
        pgClass: col.columnType,
        baseClass: col.baseColumn?.columnType,
        enumValues: col.enumValues?.length ? col.enumValues : undefined,
        tsType,
      };
    });
    entry.tables.push({ name, exportName, cols });
    definedIn.set(name, { file, exportName });
  }
  perFile.push(entry);
}

for (const { file, tables, aliases } of perFile) {
  const uses = new Set<string>();
  const bodies = tables.map((t) => tableSource(t.name, t.exportName, t.cols, uses));
  let out = header(uses) + bodies.join("\n");
  for (const a of aliases) {
    const d = definedIn.get(a.table)!;
    out += `\nexport { ${d.exportName} as ${a.exportName} } from "./${d.file.replace(/\.ts$/, ".js")}";\n`;
  }
  outputs.set(file, out);
}

// ── raw-SQL-only live tables (no PG Drizzle definition) ─────────────────────
for (const [table, { file, exportName }] of Object.entries(RAW_ONLY)) {
  if (!FP.tables[table]) throw new Error(`raw-only table ${table} missing from the fingerprint`);
  const cols: Col[] = Object.entries(FP.tables[table].columns).map(([name, c]) => ({ key: camel(name), name, ...classFromLive(c.type) }));
  const uses = new Set<string>();
  const body = tableSource(table, exportName, cols, uses);
  outputs.set(file, header(uses).replace("// GENERATED", "// GENERATED (raw-SQL-only live table; columns from the fingerprint)") + body);
}

// ── coverage: every live table exactly once, party_balances absent ─────────
const generated = new Set([...definedIn.keys(), ...Object.keys(RAW_ONLY)]);
const live = Object.keys(FP.tables);
const missing = live.filter((t) => !generated.has(t));
const extra = [...generated].filter((t) => !FP.tables[t]);
if (missing.length || extra.length || generated.has("party_balances")) {
  throw new Error(`table coverage mismatch: missing ${missing} extra ${extra}`);
}

const pgIndex = readFileSync(join(PG_DIR, "index.ts"), "utf8");
const indexLines = [
  "// GENERATED by scripts/generate-sqlite-schema.mts — mirrors ../../schemas/index.ts plus the raw-SQL-only tables.",
  ...[...pgIndex.matchAll(/export \* from "(\.\/[a-z-]+\.table\.js)";/g)].map((m) => `export * from "${m[1]}";`),
  ...Object.values(RAW_ONLY).map((r) => `export * from "./${r.file.replace(/\.ts$/, ".js")}";`),
  // SQLite-only runtime tables (hand-written, T035).
  `export * from "./motard-meta.table.js";`,
];
outputs.set("index.ts", indexLines.join("\n") + "\n");

let drift = 0;
if (!check) mkdirSync(OUT_DIR, { recursive: true });
for (const [file, content] of outputs) {
  const path = join(OUT_DIR, file);
  if (check) {
    if (!existsSync(path) || readFileSync(path, "utf8") !== content) {
      console.error(`drift: ${file}`);
      drift++;
    }
  } else {
    writeFileSync(path, content);
  }
}
console.log(`${check ? "checked" : "wrote"} ${outputs.size} files for ${generated.size} tables (${live.length} live)`);
if (drift) process.exit(1);
