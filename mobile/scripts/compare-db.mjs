// Compares the business tables of two SQLite databases (S2 / S5 / parity). Usage:
//   node mobile/scripts/compare-db.mjs <a.db> <b.db>
// Skips motard_*, sync_*, idempotency_keys and audit_log. Rows are matched by primary key; every column is
// compared except created_at and updated_at. Prints "0 differences" or each difference.
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const requireFromBackend = createRequire(path.resolve(here, "../../backend/package.json"));

const SKIP_TABLE = /^(motard_|sync_|sqlite_)|^(idempotency_keys|audit_log)$/;
const SKIP_COLUMN = new Set(["created_at", "updated_at"]);

function businessTables(db) {
  return db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
    .all()
    .map((r) => r.name)
    .filter((name) => !SKIP_TABLE.test(name));
}

function keyColumns(db, table) {
  const cols = db.prepare("SELECT name, pk FROM pragma_table_info(?) ORDER BY pk, cid").all(table);
  const pk = cols
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);
  return pk.length ? pk : cols.map((c) => c.name);
}

const show = (v) => (typeof v === "bigint" ? `${v}n` : JSON.stringify(v));

/** Returns the list of difference strings between two open better-sqlite3 databases. */
export function compareDatabases(a, b) {
  const diffs = [];
  const tablesA = businessTables(a);
  const tablesB = new Set(businessTables(b));
  for (const t of tablesA) if (!tablesB.has(t)) diffs.push(`${t}: missing in B`);
  for (const t of tablesB) if (!tablesA.includes(t)) diffs.push(`${t}: missing in A`);
  for (const table of tablesA) {
    if (!tablesB.has(table)) continue;
    const pk = keyColumns(a, table);
    const columns = a
      .prepare("SELECT name FROM pragma_table_info(?) ORDER BY cid")
      .all(table)
      .map((c) => c.name)
      .filter((c) => !SKIP_COLUMN.has(c));
    const load = (db) => {
      const stmt = db.prepare(`SELECT * FROM "${table}"`).safeIntegers(true);
      const rows = new Map();
      for (const row of stmt.all()) rows.set(pk.map((k) => String(row[k])).join("\u0001"), row);
      return rows;
    };
    const rowsA = load(a);
    const rowsB = load(b);
    for (const [key, ra] of rowsA) {
      const rb = rowsB.get(key);
      if (!rb) {
        diffs.push(`${table}[${key.replaceAll("\u0001", ",")}]: only in A`);
        continue;
      }
      for (const c of columns) {
        if (!(c in rb)) continue;
        if (show(ra[c]) !== show(rb[c])) {
          diffs.push(
            `${table}[${key.replaceAll("\u0001", ",")}].${c}: ${show(ra[c])} != ${show(rb[c])}`,
          );
        }
      }
    }
    for (const key of rowsB.keys()) {
      if (!rowsA.has(key)) diffs.push(`${table}[${key.replaceAll("\u0001", ",")}]: only in B`);
    }
  }
  return diffs;
}

export function compareFiles(fileA, fileB) {
  const Database = requireFromBackend("better-sqlite3");
  const a = new Database(fileA, { readonly: true, fileMustExist: true });
  const b = new Database(fileB, { readonly: true, fileMustExist: true });
  try {
    return compareDatabases(a, b);
  } finally {
    a.close();
    b.close();
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [fileA, fileB] = process.argv.slice(2);
  if (!fileA || !fileB) {
    console.error("usage: node mobile/scripts/compare-db.mjs <a.db> <b.db>");
    process.exit(2);
  }
  const diffs = compareFiles(fileA, fileB);
  if (diffs.length === 0) console.log("0 differences");
  else {
    for (const d of diffs) console.log(d);
    console.log(`${diffs.length} differences`);
    process.exitCode = 1;
  }
}
