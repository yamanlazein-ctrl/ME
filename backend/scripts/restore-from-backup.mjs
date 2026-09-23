/**
 * Disaster-recovery restore — rebuilds a tenant's data from a backup archive
 * produced by POST /api/backup/full (database.json + uploads/ + metadata).
 *
 * Usage:
 *   node scripts/restore-from-backup.mjs <backup.zip | extracted-folder> [--url <DATABASE_URL>] [--uploads-dir <dir>] [--reset-pull-cursor]
 *
 * What it does:
 *   1. Extracts the archive if given a .zip/.tar.gz (uses the OS `tar`, present
 *      on Windows 10+, macOS and Linux — bsdtar reads zip natively).
 *   2. Wipes the target database's rows for the backup's tenant (children-first,
 *      temporarily lifting the ledger append-only trigger).
 *   3. Re-inserts every table from database.json in FK-safe parent-first order.
 *   4. Restores the SYNC STATE with the business data (see below).
 *   5. Copies uploads/* back into the uploads directory.
 *   6. Prints before/after row counts as proof.
 *
 * Prerequisite: the target database must already have the SCHEMA applied
 * (`npm run db:migrate`) — the backup contains DATA only, by design.
 *
 * ── SYNC-STATE SEMANTICS (why the sync tables are restored, and how) ──
 * The offline story is "device is offline → pending operations → backup →
 * disaster → restore → resume synchronizing". Dropping the sync tables makes
 * that story false: `sync_outbox` rows are the not-yet-pushed work (dropping
 * them loses the operations themselves, not just a queue), `sync_inbox` is the
 * applied-op mirror that makes redelivery a no-op, `sync_state.last_pull_seq`
 * is the pull cursor, `sync_resource_claims` are first-write-wins reservations
 * (dropping them re-opens decided conflicts → duplicate stock effects),
 * `sync_tombstones` stop deleted master rows from resurrecting, and
 * `document_number_blocks` are the device's exclusive reserved number ranges.
 *
 *   - Outbox / inbox / tombstones / conflicts / claims are restored VERBATIM,
 *     including `status`, `apply_attempts`, ids and ordering columns.
 *     Re-sending a restored `pending` unit is safe even if the hub already
 *     applied it: the hub dedupes on (tenant_id, op_id) and materialization is
 *     idempotent ("exists" on pre-allocated ids) — no duplicate financial or
 *     stock effect. Units restored as `applied`/`rejected` are never re-pushed
 *     (the push selector only claims `pending`, or `pushing` past its lease).
 *   - `sync_outbox.seq` / `sync_inbox.received_seq` are bigserials, so after
 *     inserting rows with explicit values the sequences are advanced to
 *     GREATEST(current last_value, MAX(restored)) — never lowered (they are
 *     global, shared by all tenants). Without this, units enqueued after the
 *     restore would sort BEFORE the restored ones and be pushed out of order.
 *   - The pull cursor is restored, then clamped to the highest `received_seq`
 *     present in the restored inbox. A cursor above everything the database has
 *     recorded can only mean the mirror row is missing or the cursor came from
 *     a different hub's sequence space; rewinding re-pulls those units, which
 *     the restored inbox then answers as already-applied (idempotent). Use
 *     `--reset-pull-cursor` when the target hub is NOT the hub the backup came
 *     from (the recorded cursor is meaningless there) — the device re-pulls
 *     history from scratch instead of silently skipping it.
 *   - `document_number_blocks` are restored so the device keeps issuing numbers
 *     inside its own reserved range while offline. `document_sequences` is
 *     already restored alongside them, and every later hub block claim reports
 *     the local tip (`knownUsed`), so a newly carved range can never overlap
 *     numbers already in the wild. Residual risk, documented rather than
 *     hidden: if an unused tail of a restored block was reclaimed on the hub
 *     AFTER the backup and re-carved to another device, the restored block row
 *     is stale — verify with `--reset-pull-cursor`-style care by checking
 *     `document_number_blocks` vs `document_sequences` (the script prints both).
 */
import pg from "pg";
import { readFileSync, existsSync, mkdirSync, readdirSync, cpSync, rmSync, mkdtempSync } from "node:fs";
import { join, resolve, relative, sep } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

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
/**
 * Force the pull cursor to NULL so the device re-pulls its whole history from
 * the target hub. Required when the target hub is NOT the hub the backup came
 * from: `sync_state.last_pull_seq` is a position in the OTHER hub's sequence
 * space, and a stale-but-larger value makes the device skip every unit below it
 * forever (a silent, permanent divergence).
 */
const RESET_PULL_CURSOR = args.includes("--reset-pull-cursor");

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
  // Windows/GNU-tar hazards, both reproduced live on this machine:
  //   * `-f C:\...` is read as a REMOTE `host:path` spec → "Cannot connect to C".
  //   * `-C C:\...` is not understood by the MSYS build at all.
  // So: run tar with cwd = the extraction directory and pass the archive as a
  // relative, forward-slashed path. Both GNU tar and bsdtar accept that, and
  // neither form can be mistaken for `host:path`.
  const archiveAbs = resolve(sourceArg);
  const relArchive = relative(tempExtract, archiveAbs).split(sep).join("/");
  const extract = spawnSync("tar", ["-xf", relArchive], { cwd: tempExtract, stdio: "pipe" });
  if (extract.status !== 0) {
    console.error(
      `Extraction failed (tar exit ${extract.status}): ${extract.stderr?.toString().trim() || "unknown error"}`,
    );
    process.exit(1);
  }
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
// Incomplete backups are never safe to apply to an existing tenant. The old
// --allow-incomplete escape hatch could still wipe tables that were absent from
// the archive, so it is intentionally rejected until a staging restore exists.
if (Array.isArray(dump.warnings) && dump.warnings.length > 0) {
  console.error(
    `Backup has ${dump.warnings.length} warning(s) — refusing restore before any target DELETE. ` +
      `Create a complete verified backup instead.`,
  );
  console.error(JSON.stringify(dump.warnings, null, 2));
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

// ── RLS / ownership preflight ──
// The business and sync tables all carry RLS (most of them FORCE RLS), so the
// connection MUST either bypass RLS (superuser / BYPASSRLS) or run under the
// tenant GUC. On top of that, the wipe has to DROP and recreate the
// `ledger_entries` append-only trigger, which requires OWNERSHIP of that table.
// A role with neither capability used to die mid-restore with
// `error: must be owner of relation ledger_entries` — printed AFTER the RLS
// message that promised the restore would work — leaving a half-restored
// database. Refuse up front instead, before any DELETE runs.
const roleInfo = await c.query(
  `SELECT (r.rolsuper OR r.rolbypassrls) AS bypasses,
          (SELECT relowner = r.oid FROM pg_class WHERE oid = to_regclass('public.ledger_entries')) AS owns_ledger,
          r.rolname AS role_name
     FROM pg_roles r WHERE r.rolname = current_user`,
);
const bypassesRls = Boolean(roleInfo.rows[0]?.bypasses);
const ownsLedger = Boolean(roleInfo.rows[0]?.owns_ledger);
if (!bypassesRls && !ownsLedger) {
  console.error(
    `Refusing to restore: role "${roleInfo.rows[0]?.role_name}" can neither bypass row-level security nor ` +
      "manage the ledger append-only trigger (it does not own ledger_entries). Starting anyway would fail " +
      "halfway and leave the tenant half-restored.\n" +
      "Run the restore as the database owner / a superuser / a BYPASSRLS role, or transfer ownership:\n" +
      "  ALTER TABLE ledger_entries OWNER TO <role>;",
  );
  await c.end();
  process.exit(1);
}
if (!bypassesRls) {
  await c.query("SELECT set_config('app.current_tenant_id', $1, false)", [tenantId]);
  console.log(
    `RLS: role cannot bypass row-level security but owns the tables — restoring under the tenant GUC (tenant ${tenantId}).`,
  );
} else {
  console.log("RLS: restoring as a role that bypasses row-level security.");
}

// FK-safe order for DELETE (children first) and INSERT (parents first).
// tenants/users/company_profiles/settings are upserted, never deleted.
//
// Sync tables follow the business tables and keep the SAME discipline
// (SYNC-OPERATIONS.md §Backup/restore): they are durable production state, not
// caches. They are part of the tenant snapshot, so they are wiped and rebuilt
// together with it — leaving post-backup rows behind would mix two points in
// time and make the (tenant_id, op_id) uniqueness silently skip rows.
// FK order inside the group: everything that references `sync_devices`
// (outbox / inbox / claims / blocks / tombstones) must be deleted BEFORE it and
// inserted AFTER it.
const DELETE_ORDER = [
  "stock_movements", "invoice_lines", "return_lines", "order_items", "print_jobs",
  "vouchers", "returns", "orders", "invoices",
  "ledger_entry_archive", "yearly_party_summaries", "ledger_entries",
  "day_closes", "manual_movements", "cashbox_sessions", "expenses",
  "notifications", "idempotency_keys", "attachments", "audit_logs",
  "rolls", "colors", "fabrics", "parties", "document_sequences",
  // ── sync state (children of sync_devices first) ──
  "sync_conflicts", "sync_tombstones", "sync_resource_claims", "sync_inbox",
  "sync_outbox", "document_number_blocks", "sync_state", "sync_devices",
];
const INSERT_ORDER = [
  // tenants FIRST — every other table references it (critical on a clean machine)
  "tenants",
  // sync_devices references tenants + users, so it lands after both.
  "company_profiles", "users", "sync_devices", "fabrics", "parties", "colors", "rolls",
  "settings", "document_sequences",
  // document_number_blocks references sync_devices; outbox/inbox/claims do too.
  "document_number_blocks", "sync_outbox", "sync_inbox", "sync_state",
  "sync_resource_claims", "sync_tombstones", "sync_conflicts",
  "orders", "order_items", "invoices", "invoice_lines", "vouchers",
  "ledger_entries", "expenses", "returns", "return_lines", "print_jobs",
  "notifications", "stock_movements", "attachments", "audit_logs",
  "idempotency_keys", "ledger_entry_archive", "yearly_party_summaries",
  "cashbox_sessions", "day_closes", "manual_movements",
];

/**
 * Monotonic ordering columns backed by a sequence. Restoring rows with explicit
 * values does NOT advance the sequence, so without this fix-up post-restore
 * inserts would receive values BELOW the restored maximum: `sync_outbox.seq` is
 * the documented hub replay order and `sync_inbox.received_seq` IS the pull
 * cursor. `audit_logs.id` and `idempotency_keys.id` are bigserial PRIMARY KEYS
 * whose inserts omit the id, so a restore without this fix-up makes the very
 * first audit write and the first `Idempotency-Key` request after the restore
 * fail with a duplicate-key error.
 */
const SERIAL_COLUMNS = [
  { table: "sync_outbox", column: "seq" },
  { table: "sync_inbox", column: "received_seq" },
  { table: "audit_logs", column: "id" },
  { table: "idempotency_keys", column: "id" },
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
console.log("Existing tenant rows cleared in the pending restore transaction.");

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
  let attempted = 0;
  try {
    for (const row of rows) {
      const values = cols.map((col) => jsonReplacer(row[col]));
      const placeholders = cols.map((_, i) => `$${i + 1}`).join(", ");
      const colList = cols.map((cl) => `"${cl}"`).join(", ");
      const res = await c.query(
        `INSERT INTO "${table}" (${colList}) VALUES (${placeholders})`,
        values,
      );
      attempted++;
      count += res.rowCount ?? 0;
    }
    console.log(`restored ${table}: ${count} rows`);
    if (count !== attempted) {
      throw new Error(`Restore skipped ${attempted - count} rows in ${table}; refusing partial restore`);
    }

  } catch (e) {
    await c.query("ROLLBACK");
    console.error(`FAILED on ${table}:`, e.message.split("\n")[0]);
    process.exit(1);
  }
}

// ── 4b. sync-state continuity ──
// Restoring the rows is not enough: the ORDERING state must line up with them.

// (a) Advance the bigserial sequences past the restored maximum. A restored row
// with seq = N does not move the sequence, so the next locally-enqueued unit
// would get a seq BELOW N and be pushed before units the device already
// recorded (the hub replays in seq order). GREATEST with the live value keeps
// the fix-up safe on a shared database where other tenants have moved it on.
for (const { table, column } of SERIAL_COLUMNS) {
  const seqRes = await c.query("SELECT pg_get_serial_sequence($1, $2) AS s", [table, column]);
  const seq = seqRes.rows[0]?.s;
  if (!seq) continue; // table/column absent in this schema version
  const maxRes = await c.query(
    `SELECT COALESCE(MAX("${column}"), 0)::bigint AS m FROM "${table}"`,
  );
  const restoredMax = Number(maxRes.rows[0].m);
  const live = (await c.query(`SELECT last_value::bigint AS l, is_called FROM ${seq}`)).rows[0];
  const liveNext = live?.is_called ? Number(live.l) + 1 : Number(live?.l ?? 1);
  const target = Math.max(restoredMax + 1, liveNext, 1);
  await c.query("SELECT setval($1::regclass, $2::bigint, false)", [seq, target]);
  console.log(
    `sequence ${seq}: next value = ${target} (highest restored ${column} = ${restoredMax})`,
  );
}

// (b) Pull-cursor rule. `sync_state.last_pull_seq` is a position in the HUB's
// sequence space, and the pull stream only returns units ABOVE it.
//   - default: restored as recorded, but never left ABOVE the highest
//     `received_seq` in the restored inbox. A cursor past everything this
//     database has recorded can only mean the inbox mirror row is missing or
//     the cursor came from another hub's sequence space — and a too-high cursor
//     skips operations SILENTLY. Rewinding re-pulls them, and the restored
//     inbox answers already-applied units idempotently, so nothing is applied
//     twice.
//   - `--reset-pull-cursor`: cursor → NULL for the documented "different hub"
//     case, forcing a full (idempotent) re-pull instead of skipping.
const restoredInbox = Array.isArray(tables.sync_inbox) ? tables.sync_inbox : [];
const inboxMax = restoredInbox.reduce((m, r) => Math.max(m, Number(r.received_seq ?? 0)), 0);
const restoredState = Array.isArray(tables.sync_state) ? tables.sync_state[0] : null;
const restoredCursor =
  restoredState?.last_pull_seq == null ? null : Number(restoredState.last_pull_seq);

if (RESET_PULL_CURSOR) {
  await c.query(
    `UPDATE sync_state SET last_pull_seq = NULL, last_pull_at = NULL WHERE tenant_id = $1`,
    [tenantId],
  );
  console.log(
    "pull cursor RESET (--reset-pull-cursor): the device will re-pull its whole history; " +
      "already-applied units are answered from the restored inbox, so re-pulling is idempotent.",
  );
} else if (restoredCursor !== null && restoredCursor > inboxMax) {
  await c.query(`UPDATE sync_state SET last_pull_seq = $2 WHERE tenant_id = $1`, [
    tenantId,
    inboxMax,
  ]);
  console.log(
    `pull cursor CLAMPED: backup cursor ${restoredCursor} > highest restored inbox received_seq ${inboxMax}. ` +
      "A cursor above every recorded unit would skip operations silently; rewinding re-pulls them idempotently. " +
      "If this backup came from a DIFFERENT hub, re-run with --reset-pull-cursor.",
  );
} else if (restoredCursor !== null) {
  console.log(
    `pull cursor restored at ${restoredCursor} (highest restored inbox received_seq ${inboxMax}).`,
  );
} else {
  console.log("pull cursor: none in the backup — next pull starts from the beginning.");
}

// (c) Show the restored sync state so the operator can see pending work
// survived and knows what may need attention after the restore.
const syncCount = async (t) => {
  const exists = await c.query(
    "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema='public' AND table_name=$1",
    [t],
  );
  if (Number(exists.rows[0].n) === 0) return null;
  const r = await c.query(`SELECT count(*)::int AS n FROM "${t}" WHERE tenant_id = $1`, [tenantId]);
  return Number(r.rows[0].n);
};
const syncSummary = {};
for (const t of [
  "sync_devices",
  "sync_outbox",
  "sync_inbox",
  "sync_state",
  "sync_resource_claims",
  "document_number_blocks",
  "sync_tombstones",
  "sync_conflicts",
]) {
  const n = await syncCount(t);
  if (n !== null) syncSummary[t] = n;
}
const outboxStatuses = (
  await c.query(
    `SELECT status, count(*)::int AS n FROM sync_outbox WHERE tenant_id = $1 GROUP BY status ORDER BY status`,
    [tenantId],
  )
).rows;
const blocks = (
  await c.query(
    `SELECT entity_type, status, count(*)::int AS n FROM document_number_blocks
      WHERE tenant_id = $1 GROUP BY entity_type, status ORDER BY entity_type, status`,
    [tenantId],
  )
).rows;
console.log("RESTORED SYNC STATE:", JSON.stringify(syncSummary));
console.log("OUTBOX BY STATUS:", JSON.stringify(outboxStatuses));
console.log("NUMBER BLOCKS:", JSON.stringify(blocks));
const pendingRestored = outboxStatuses
  .filter((r) => r.status === "pending" || r.status === "pushing")
  .reduce((n, r) => n + Number(r.n), 0);
if (pendingRestored > 0) {
  console.log(
    `→ ${pendingRestored} unit(s) still owe the hub a push. They are durable; the device drains them on the next ` +
      "`POST /api/sync/run` (a unit restored as `pushing` is reclaimed after its 5-minute lease).",
  );
}
if (syncSummary.sync_resource_claims > 0) {
  console.log(
    "→ Claims were restored as first-write-wins reservations. A claim whose holder became `dead` AFTER this " +
      "backup is stale by construction; release it with the operator path `POST /api/sync/claims/reap` " +
      "(terminal-gated: it never releases a live claim).",
  );
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
for (const t of [
  "parties", "invoices", "invoice_lines", "ledger_entries", "vouchers",
  // Sync state is verified like any other durable data.
  "sync_outbox", "sync_inbox", "sync_state", "sync_devices",
  "sync_resource_claims", "document_number_blocks",
]) {
  const r = await c.query(
    `SELECT count(*) AS n FROM "${t}" WHERE tenant_id = $1`,
    [tenantId],
  );
  verify[t] = Number(r.rows[0].n);
}
console.log("VERIFIED RESTORED COUNTS:", JSON.stringify(verify));

// ── 7. invariant: no pending operation may be lost by the restore ──
// This is the whole point of restoring the outbox: units that had not reached
// the hub at backup time must still be there (and still be drainable) after the
// restore. A mismatch is a hard failure — a silent loss here is exactly the
// divergence this restore path exists to prevent.
const backupOutbox = Array.isArray(tables.sync_outbox) ? tables.sync_outbox : [];
const expectPending = backupOutbox.filter(
  (r) => r.status === "pending" || r.status === "pushing",
).length;
const actualPending = Number(
  (
    await c.query(
      `SELECT count(*)::int AS n FROM sync_outbox WHERE tenant_id = $1 AND status IN ('pending','pushing')`,
      [tenantId],
    )
  ).rows[0].n,
);
if (actualPending !== expectPending) {
  console.error(
    `RESTORE INVARIANT VIOLATED: backup had ${expectPending} un-pushed unit(s), database has ${actualPending}. ` +
      "Refusing to report success — unpushed operations were lost.",
  );
  await c.end();
  process.exit(1);
}
console.log(
  `PENDING-OUTBOX INVARIANT: ${expectPending} un-pushed unit(s) in the backup, ${actualPending} restored — no operation lost.`,
);

// Commit only after all inserts, sequence fixes, cursor checks, and invariants pass.
await c.query("COMMIT");
console.log("✅ Restore complete.");
await c.end();
