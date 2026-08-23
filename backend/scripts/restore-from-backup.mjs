/**
 * Disaster-recovery restore — rebuilds a tenant's data from a backup archive
 * produced by POST /api/backup/full (database.json + uploads/ + metadata).
 *
 * Usage:
 *   node scripts/restore-from-backup.mjs <backup.zip | extracted-folder> [--url <DATABASE_URL>] [--uploads-dir <dir>]
 *
 * What it does:
 *   1. Extracts the archive if given a .zip/.tar.gz (uses the OS `tar`, present
 *      on Windows 10+, macOS and Linux — bsdtar reads zip natively).
 *   2. Wipes the target database's rows for the backup's tenant (children-first,
 *      temporarily lifting the ledger append-only trigger).
 *   3. Re-inserts every table from database.json in FK-safe parent-first order.
 *   4. Copies uploads/* back into the uploads directory.
 *   5. Prints before/after row counts as proof.
 *
 * Prerequisite: the target database must already have the SCHEMA applied
 * (`npm run db:migrate`) — the backup contains DATA only, by design.
 */
import pg from "pg";
import { readFileSync, existsSync, mkdirSync, readdirSync, cpSync, rmSync, mkdtempSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

// ── args ──
const args = process.argv.slice(2);
const sourceArg = args.find((a) => !a.startsWith("--"));
const urlArgIdx = args.indexOf("--url");
const DATABASE_URL =
  (urlArgIdx !== -1 ? args[urlArgIdx + 1] : undefined) ??
  process.env.DATABASE_URL ??
  "postgresql://postgres:postgres@localhost:5432/erp";
const uploadsDirIdx = args.indexOf("--uploads-dir");
const UPLOADS_DIR = resolve(
  (uploadsDirIdx !== -1 ? args[uploadsDirIdx + 1] : undefined) ?? join(process.cwd(), "uploads"),
);

if (!sourceArg) {
  console.error("Usage: node scripts/restore-from-backup.mjs <backup.zip|folder> [--url <DB_URL>] [--uploads-dir <dir>]");
  process.exit(1);
}

// ── 1. locate/extract ──
let workDir = resolve(sourceArg);
let tempExtract = null;
if (!existsSync(join(workDir, "database.json"))) {
  const isArchive = /\.(zip|tar\.gz|tgz|tar)$/i.test(sourceArg);
  if (!isArchive || !existsSync(sourceArg)) {
    console.error(`No database.json found in "${sourceArg}" (and it is not a readable archive).`);
    process.exit(1);
  }
  tempExtract = mkdtempSync(join(tmpdir(), "erp-restore-"));
  console.log("Extracting archive…");
  execSync(`tar -xf "${resolve(sourceArg)}" -C "${tempExtract}"`, { stdio: "pipe" });
  // archives were created with `tar czf out.tar.gz .` → files may sit at root
  // of extraction or one level down; find database.json.
  const find = (dir) => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isFile() && e.name === "database.json") return dir;
      if (e.isDirectory()) {
        const hit = find(p);
        if (hit) return hit;
      }
    }
    return null;
  };
  workDir = find(tempExtract);
  if (!workDir) {
    console.error("database.json not found inside the archive.");
    process.exit(1);
  }
}

const dump = JSON.parse(readFileSync(join(workDir, "database.json"), "utf8"));
const { tenantId, tables } = dump;
if (!tenantId || typeof tables !== "object") {
  console.error("Invalid backup format (missing tenantId / tables).");
  process.exit(1);
}
console.log(`Backup: exported ${dump.exportedAt} · tenant ${tenantId}`);
console.log(`Target DB: ${DATABASE_URL}`);

// ── 2. connect ──
const c = new pg.Client({ connectionString: DATABASE_URL });
await c.connect();

const schemaCheck = await c.query(
  "SELECT count(*) AS n FROM information_schema.tables WHERE table_schema='public' AND table_name='tenants'",
);
if (Number(schemaCheck.rows[0].n) === 0) {
  console.error('Schema not found. Run migrations first:  npm run db:migrate');
  process.exit(1);
}

// FK-safe order for DELETE (children first) and INSERT (parents first).
// tenants/users/company_profiles/settings are upserted, never deleted.
const DELETE_ORDER = [
  "stock_movements", "invoice_lines", "return_lines", "order_items", "print_jobs",
  "vouchers", "returns", "orders", "invoices",
  "ledger_entry_archive", "yearly_party_summaries", "ledger_entries",
  "day_closes", "manual_movements", "cashbox_sessions", "expenses",
  "notifications", "idempotency_keys", "attachments", "audit_logs",
  "rolls", "colors", "fabrics", "parties", "document_sequences",
];
const INSERT_ORDER = [
  // tenants FIRST — every other table references it (critical on a clean machine)
  "tenants",
  "company_profiles", "users", "fabrics", "parties", "colors", "rolls",
  "settings", "document_sequences",
  "orders", "order_items", "invoices", "invoice_lines", "vouchers",
  "ledger_entries", "expenses", "returns", "return_lines", "print_jobs",
  "notifications", "stock_movements", "attachments", "audit_logs",
  "idempotency_keys", "ledger_entry_archive", "yearly_party_summaries",
  "cashbox_sessions", "day_closes", "manual_movements",
];

// ── 3. wipe existing tenant data (idempotent restore) ──
await c.query("BEGIN");
await c.query("DROP TRIGGER IF EXISTS trg_ledger_entries_append_only ON ledger_entries");
for (const t of DELETE_ORDER) {
  const hasTenantCol = await c.query(
    `SELECT count(*) AS n FROM information_schema.columns WHERE table_name=$1 AND column_name='tenant_id'`,
    [t],
  );
  if (Number(hasTenantCol.rows[0].n) > 0) {
    await c.query(`DELETE FROM "${t}" WHERE tenant_id = $1`, [tenantId]);
  }
}
await c.query(
  `CREATE TRIGGER trg_ledger_entries_append_only
   BEFORE UPDATE OR DELETE ON ledger_entries
   FOR EACH ROW EXECUTE FUNCTION fn_ledger_entries_append_only()`,
);
await c.query("COMMIT");
console.log("Existing tenant rows cleared.");

// ── 4. insert in FK-safe order ──
// Arrays must be passed AS-IS (node-pg converts JS arrays to Postgres
// arrays, e.g. tenants.license_features text[]) — stringifying them would
// produce '[…]' which Postgres cannot parse as an array literal.
// Plain objects are JSON strings (jsonb columns).
const jsonReplacer = (v) =>
  v !== null && typeof v === "object" && !Array.isArray(v) ? JSON.stringify(v) : v;

for (const table of INSERT_ORDER) {
  const rows = tables[table];
  if (!Array.isArray(rows) || rows.length === 0) continue;

  // discover actual columns so extra/missing dump keys don't break the insert
  const colRes = await c.query(
    `SELECT column_name FROM information_schema.columns WHERE table_name=$1`,
    [table],
  );
  const dbCols = new Set(colRes.rows.map((r) => r.column_name));
  const cols = Object.keys(rows[0]).filter((k) => dbCols.has(k));
  if (cols.length === 0) continue;

  let count = 0;
  await c.query("BEGIN");
  try {
    for (const row of rows) {
      const values = cols.map((col) => jsonReplacer(row[col]));
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
      const colList = cols.map((cl) => `"${cl}"`).join(", ");
      await c.query(
        `INSERT INTO "${table}" (${colList}) VALUES (${placeholders}) ON CONFLICT DO NOTHING`,
        values,
      );
      count++;
    }
    await c.query("COMMIT");
    console.log(`restored ${table}: ${count} rows`);
  } catch (e) {
    await c.query("ROLLBACK");
    console.error(`FAILED on ${table}:`, e.message.split("\n")[0]);
    process.exit(1);
  }
}

// ── 5. uploads folder ──
const uploadsSrc = join(workDir, "uploads");
if (existsSync(uploadsSrc)) {
  mkdirSync(UPLOADS_DIR, { recursive: true });
  cpSync(uploadsSrc, UPLOADS_DIR, { recursive: true });
  console.log(`uploads restored → ${UPLOADS_DIR}`);
} else {
  console.log("No uploads folder in this backup.");
}

if (tempExtract) rmSync(tempExtract, { recursive: true, force: true });

// ── 6. summary ──
const verify = {};
for (const t of ["parties", "invoices", "invoice_lines", "ledger_entries", "vouchers"]) {
  const r = await c.query(
    `SELECT count(*) AS n FROM "${t}" WHERE tenant_id = $1`,
    [tenantId],
  );
  verify[t] = Number(r.rows[0].n);
}
console.log("VERIFIED RESTORED COUNTS:", JSON.stringify(verify));
console.log("✅ Restore complete.");
await c.end();
