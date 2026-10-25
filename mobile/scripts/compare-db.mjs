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

// ── convergence comparison (parity harness) ─────────────────────────────────────────────────────
// The AC-8 rule (scripts/parity/lib/syncAc8.mjs): per-node tables never converge; rows every node derives itself when it
// materialises a document have locally minted ids and are compared by content.
const NODE_LOCAL_TABLES = new Set([
  "sync_outbox",
  "sync_inbox",
  "sync_state",
  "sync_conflicts",
  "sync_resource_claims",
  "sync_devices",
  "sync_device_authorized_users",
  "sync_tombstones",
  "document_number_blocks",
  "audit_logs",
  "notifications",
  "idempotency_keys",
  "revoked_tokens",
  "secrets",
  "device_registrations",
  "license_activations",
  "licenses",
  "license_audit_events",
  "server_installations",
  "invitation_codes",
  "setup_wizard_state",
  "tenants",
  "users",
  "print_jobs",
  "backup_runs",
  "financial_operations",
  "document_sequences",
]);
const NODE_LOCAL_COLUMN =
  /^(created_at|updated_at|synced_at|materialized_at|applied_at|received_at|cancelled_at|client_operation_id)$/;
const DERIVED_ID_TABLES = new Set(["invoice_lines", "ledger_entries", "stock_movements"]);

function projectBusiness(db) {
  const out = {};
  for (const table of businessTables(db)) {
    if (NODE_LOCAL_TABLES.has(table)) continue;
    const dropId = DERIVED_ID_TABLES.has(table);
    out[table] = db
      .prepare(`SELECT * FROM "${table}"`)
      .safeIntegers(true)
      .all()
      .map((row) =>
        JSON.stringify(
          Object.entries(row)
            .filter(([k]) => !NODE_LOCAL_COLUMN.test(k) && !(dropId && k === "id"))
            .sort(([x], [y]) => (x < y ? -1 : 1))
            .map(([k, v]) => [k, typeof v === "bigint" ? `${v}n` : v]),
        ),
      )
      .sort();
  }
  return out;
}

/** Differences in converged business state between two open databases; each line names the table and the rows. */
export function compareBusinessState(a, b, labelA = "A", labelB = "B") {
  const left = projectBusiness(a);
  const right = projectBusiness(b);
  const lines = [];
  for (const table of [...new Set([...Object.keys(left), ...Object.keys(right)])].sort()) {
    const l = new Set(left[table] ?? []);
    const r = new Set(right[table] ?? []);
    const onlyL = [...l].filter((x) => !r.has(x));
    const onlyR = [...r].filter((x) => !l.has(x));
    if (!onlyL.length && !onlyR.length) continue;
    lines.push(
      `${table}: ${l.size} rows on ${labelA}, ${r.size} on ${labelB}; ${onlyL.length} only on ${labelA}, ${onlyR.length} only on ${labelB}`,
    );
    for (const x of onlyL.slice(0, 2)) lines.push(`  ${labelA}: ${x.slice(0, 300)}`);
    for (const x of onlyR.slice(0, 2)) lines.push(`  ${labelB}: ${x.slice(0, 300)}`);
  }
  return lines;
}

export function compareBusinessFiles(fileA, fileB, labelA, labelB) {
  const Database = requireFromBackend("better-sqlite3");
  const a = new Database(fileA, { readonly: true, fileMustExist: true });
  const b = new Database(fileB, { readonly: true, fileMustExist: true });
  try {
    return compareBusinessState(a, b, labelA, labelB);
  } finally {
    a.close();
    b.close();
  }
}
