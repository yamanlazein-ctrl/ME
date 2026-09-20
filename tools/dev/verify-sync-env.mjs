/**
 * Connectivity + schema probe for the sync subsystem.
 * Read-only: reports which databases exist and which sync tables/migrations are present.
 * Usage: node scripts/verify-sync-env.mjs
 */
import pg from "pg";

const HOST = process.env.PGHOST || "localhost";
const PORT = Number(process.env.PGPORT || 5432);
const USER = process.env.PGUSER || "postgres";
const PASS = process.env.PGPASSWORD || "postgres";

const targets = process.argv.slice(2);
const dbs = targets.length > 0 ? targets : ["erp", "erp_test", "fabric_erp"];

const admin = new pg.Client({ host: HOST, port: PORT, user: USER, password: PASS, database: "postgres" });
await admin.connect();
const all = await admin.query("select datname from pg_database where datistemplate = false order by 1");
console.log("databases:", all.rows.map((r) => r.datname).join(", "));
await admin.end();

const REQUIRED = [
  "sync_devices",
  "sync_outbox",
  "sync_inbox",
  "document_number_blocks",
  "sync_resource_claims",
  "sync_state",
];

for (const db of dbs) {
  const c = new pg.Client({ host: HOST, port: PORT, user: USER, password: PASS, database: db });
  try {
    await c.connect();
  } catch (err) {
    console.log(`\n[${db}] SKIP — ${err.message}`);
    continue;
  }
  const t = await c.query(
    `select table_name from information_schema.tables
     where table_schema='public' and table_name = any($1::text[]) order by 1`,
    [REQUIRED],
  );
  const have = t.rows.map((r) => r.table_name);
  const missing = REQUIRED.filter((r) => !have.includes(r));
  console.log(`\n[${db}] sync tables: ${have.length}/${REQUIRED.length}`);
  if (missing.length) console.log(`  missing: ${missing.join(", ")}`);
  if (have.length) {
    const mig = await c.query(
      `select count(*)::int as c, max(created_at) as last from __drizzle_migrations`,
    ).catch(() => ({ rows: [{ c: "n/a", last: null }] }));
    console.log(`  migrations applied: ${mig.rows[0].c} (last: ${mig.rows[0].last ?? "n/a"})`);
    const counts = await c
      .query(
        `select
           (select count(*)::int from sync_outbox)  as outbox,
           (select count(*)::int from sync_inbox)   as inbox,
           (select count(*)::int from sync_devices) as devices,
           (select count(*)::int from sync_resource_claims) as claims`,
      )
      .catch(() => null);
    if (counts) {
      const r = counts.rows[0];
      console.log(
        `  rows: outbox=${r.outbox} inbox=${r.inbox} devices=${r.devices} claims=${r.claims}`,
      );
    }
  }
  await c.end();
}
