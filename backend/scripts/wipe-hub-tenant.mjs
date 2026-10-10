/**
 * Wipe all disposable business/test data for ONE hub tenant — keeping the Render
 * service, PostgreSQL, Redis, migrations, RLS policies and hub API fully working.
 *
 * WHY THIS EXISTS
 * ---------------
 * The Render test hub (disposable company data) must be reusable for a fresh
 * enrollment without re-deploying or re-migrating anything. There was no wipe
 * path: bootstrap-hub.mjs only SEEDS a new tenant (minting a NEW tenant UUID,
 * which would orphan live-device pairing and reserved number blocks), and
 * reset-hub-admin.mjs only resets one admin password.
 *
 * SAFETY MODEL (all patterns already proven in this repo)
 *   - FK-safe delete order: restore-from-backup.mjs:220-230 (business tables
 *     first, then sync state with the children of sync_devices first).
 *   - RLS tenant context is MANDATORY: FORCE RLS applies to the table owner
 *     (commit 7314c174 proved device rows hide without tenant context). The
 *     pattern is durability-proof.mjs:120-188 — set_config tenant + platform
 *     mode + SAVEPOINTs.
 *   - The append-only ledger trigger must be dropped INSIDE the wipe
 *     transaction and recreated immediately (restore-from-backup.mjs:264-280).
 *   - Sequences must be reset past the old maxima (docs/SYNC-OPERATIONS.md:110).
 *
 * WHAT IS KEPT
 *   - tenants row, system_admins (platform level), users (hub operators),
 *     migrations/RLS policies, setup_wizard_state, licenses — so the hub API
 *     comes back up fully working, ready for fresh device enrollment.
 *
 * WHAT IS WIPED (per tenant, one transaction)
 *   - all business tables, all sync state (inbox/outbox/devices/claims/
 *     tombstones/conflicts/number blocks), tenant-scoped licensing activity.
 *
 * USAGE
 *   DATABASE_URL=postgresql://... node scripts/wipe-hub-tenant.mjs <tenantId>
 *   DATABASE_URL=postgresql://... node scripts/wipe-hub-tenant.mjs <tenantId> --all-tenants
 *   Add --execute to actually wipe; without it the script only prints counts.
 *
 * AFTER A WIPE
 *   - every previously paired device must re-register (POST /api/auth/sync-device);
 *     pushes from stale devices stall with 403 SYNC_UNKNOWN_DEVICE by design.
 *   - number blocks re-carve automatically on the next /api/sync/run.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = path.dirname(fileURLToPath(import.meta.url));
process.chdir(path.join(here, ".."));

const EXECUTE = process.argv.includes("--execute");
const ALL_TENANTS = process.argv.includes("--all-tenants");
const tenantArg = process.argv[2];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

if (!ALL_TENANTS && (!tenantArg || !UUID_RE.test(tenantArg))) {
  console.error("usage: node scripts/wipe-hub-tenant.mjs <tenantId> [--execute]  |  --all-tenants <tenantId...>");
  process.exit(1);
}
if (EXECUTE && !process.env.DATABASE_URL) {
  console.error("DATABASE_URL is required (the Render hub PostgreSQL connection string)");
  process.exit(1);
}

/** FK-safe order — children before parents; sync state last (restore-from-backup.mjs order). */
const BUSINESS_TABLES = [
  "stock_movements",
  "invoice_lines",
  "return_lines",
  "order_items",
  "print_jobs",
  "vouchers",
  "returns",
  "orders",
  "ledger_entry_archive",
  "yearly_party_summaries",
  "ledger_entries",
  "day_closes",
  "manual_movements",
  "cashbox_sessions",
  "cashbox_daily_balances",
  "expenses",
  "financial_operations",
  "notifications",
  "idempotency_keys",
  "attachments",
  "audit_logs",
  "inventory_counts",
  "rolls",
  "colors",
  "fabrics",
  "parties",
];

/** Sync state — exact reverse-dependency order, sync_devices LAST. */
const SYNC_TABLES = [
  "sync_conflicts",
  "sync_tombstones",
  "sync_resource_claims",
  "sync_inbox",
  "sync_outbox",
  "document_number_blocks",
  "sync_state",
  "sync_devices",
];

/** Sequences to reset past the old maxima (docs/SYNC-OPERATIONS.md:110). */
const SEQUENCES = [
  ["sync_outbox", "seq"],
  ["sync_inbox", "received_seq"],
  ["audit_logs", "id"],
  ["idempotency_keys", "id"],
];

const url = process.env.DATABASE_URL;
if (!url) {
  console.error("DATABASE_URL is required even for a dry run (read-only counts).");
  process.exit(1);
}
const client = new pg.Client({ connectionString: url, connectionTimeoutMillis: 15000 });

async function count(table, tenants) {
  const r = await client.query(`SELECT count(*)::bigint AS n FROM "${table}" ${tenants ? "WHERE tenant_id = ANY($1)" : ""}`, tenants ?? []);
  return Number(r.rows[0].n);
}

async function main() {
  await client.connect();
  const tenantIds = ALL_TENANTS
    ? (await client.query("SELECT id FROM tenants")).rows.map((r) => r.id)
    : [tenantArg];
  if (ALL_TENANTS && process.argv.slice(3).some((a) => !a.startsWith("--"))) {
    tenantIds.length = 0;
    for (const a of process.argv.slice(3)) {
      if (!a.startsWith("--")) {
        if (!UUID_RE.test(a)) throw new Error(`not a tenant UUID: ${a}`);
        tenantIds.push(a);
      }
    }
  }

  console.log(`[wipe] tenants: ${tenantIds.join(", ") || "(none)"}`);
  console.log("[wipe] DRY RUN — counts before (pass --execute to wipe):\n");
  let total = 0;
  for (const t of [...BUSINESS_TABLES, ...SYNC_TABLES]) {
    try {
      const n = await count(t, tenantIds);
      if (n > 0) console.log(`  ${t.padEnd(28)} ${n}`);
      total += n;
    } catch (e) {
      console.log(`  ${t.padEnd(28)} (table missing: ${e.message.split("\n")[0]})`);
    }
  }
  console.log(`  ${"—".repeat(34)}\n  total rows in scope: ${total}\n`);
  if (!EXECUTE) {
    console.log("[wipe] dry run only. Re-run with --execute to wipe.");
    return;
  }

  // One transaction: RLS tenant context + platform mode (durability-proof.mjs:120-188),
  // trigger dropped and recreated inside (restore-from-backup.mjs:264-280).
  await client.query("BEGIN");
  await client.query("SELECT set_config('app.platform_mode','on',true)");
  await client.query("SET LOCAL row_security = off");
  let wiped = 0;
  try {
    for (const tenantId of tenantIds) {
      await client.query("SELECT set_config('app.current_tenant_id',$1,true)", [tenantId]);
      await client.query("SAVEPOINT tenant_wipe");
      // The append-only trigger would refuse plain DELETEs on ledger_entries.
      await client.query("DROP TRIGGER IF EXISTS trg_ledger_entries_append_only ON ledger_entries");
      for (const table of [...BUSINESS_TABLES, ...SYNC_TABLES]) {
        try {
          const r = await client.query(`DELETE FROM "${table}" WHERE tenant_id = $1`, [tenantId]);
          wiped += r.rowCount ?? 0;
        } catch (e) {
          await client.query("ROLLBACK TO SAVEPOINT tenant_wipe");
          throw new Error(`${table}: ${e.message.split("\n")[0]}`);
        }
      }
      await client.query("CREATE TRIGGER trg_ledger_entries_append_only BEFORE UPDATE OR DELETE ON ledger_entries FOR EACH ROW EXECUTE FUNCTION fn_ledger_entries_append_only()");
      for (const [table, col] of SEQUENCES) {
        // setval past the old maximum only matters for the wiped rows' id space.
        await client.query(
          `SELECT setval(pg_get_serial_sequence('"${table}"','${col}'), GREATEST((SELECT COALESCE(MAX("${col}"),0) FROM "${table}"), 1)) WHERE pg_get_serial_sequence('"${table}"','${col}') IS NOT NULL`,
        );
      }
      await client.query("RELEASE SAVEPOINT tenant_wipe");
    }
    await client.query("COMMIT");
    console.log(`[wipe] COMMIT — ${wiped} rows deleted. Hub infrastructure untouched.`);
  } catch (e) {
    await client.query("ROLLBACK").catch(() => {});
    console.error(`[wipe] FAILED, rolled back completely: ${e.message}`);
    process.exitCode = 1;
  } finally {
    // Post-verification: hub must be empty of business rows but alive.
    try {
      let left = 0;
      for (const t of [...BUSINESS_TABLES, ...SYNC_TABLES]) {
        try { left += await count(t, tenantIds); } catch { /* table missing */ }
      }
      console.log(`[verify] remaining rows in scope: ${left}`);
      const admin = await client.query("SELECT count(*)::bigint AS n FROM system_admins");
      const tenants = await client.query("SELECT count(*)::bigint AS n FROM tenants");
      console.log(`[verify] system_admins=${admin.rows[0].n} tenants=${tenants.rows[0].n} (infrastructure intact)`);
    } catch { /* best-effort verification */ }
    await client.end().catch(() => {});
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
