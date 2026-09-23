#!/usr/bin/env node
/**
 * verify-pgdata-template.mjs — hard release gate for the desktop database template.
 *
 * Never touches the shipped template: it copies it to a temp dir, opens that copy with the
 * bundled PostgreSQL and checks that it is
 *   - a cleanly shut down cluster (pg_control state "shut down", no postmaster.pid),
 *   - fully migrated (applied == drizzle journal),
 *   - empty except company + admin + baked license (every business table 0 rows),
 *   - document_sequences empty (first invoice number is 1),
 *   - matching its manifest.
 * The build refuses to produce an installer when any check fails.
 *
 * Usage: node desktop/scripts/verify-pgdata-template.mjs
 */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TEMPLATE_DIR,
  TEMPLATE_MANIFEST,
  assertCleanSeed,
  databaseUrl,
  freePort,
  startPostgres,
  stopPostgresClean,
  withClient,
} from "./pgdata-template-lib.mjs";

const log = (m) => console.log(`[verify-pgdata-template] ${m}`);
// `fail` THROWS so the `finally` below always stops the temporary PostgreSQL server (an exit would leak it).
const fail = (m) => {
  throw new Error(m);
};
process.on("uncaughtException", (e) => {
  console.error(`[verify-pgdata-template] FAILED: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});

if (!existsSync(join(TEMPLATE_DIR, "PG_VERSION"))) fail(`no template at ${TEMPLATE_DIR} — run build-pgdata-template.mjs`);
if (!existsSync(TEMPLATE_MANIFEST)) fail("pgdata-template.manifest.json is missing");
const manifest = JSON.parse(readFileSync(TEMPLATE_MANIFEST, "utf8"));

for (const f of ["postmaster.pid"]) {
  if (existsSync(join(TEMPLATE_DIR, f))) fail(`template contains stale ${f}`);
}

const work = mkdtempSync(join(tmpdir(), "motard-template-verify-"));
const copy = join(work, "pgdata");
let started = false;
try {
  cpSync(TEMPLATE_DIR, copy, { recursive: true });
  const port = await freePort();
  const pgLog = join(work, "pg.log");
  startPostgres(copy, port, pgLog);
  started = true;
  // Clean-shutdown proof: opening a cleanly stopped cluster logs "shut down at ..."; a cluster left
  // by a crash / `-m immediate` logs "not properly shut down; automatic recovery in progress".
  const serverLog = readFileSync(pgLog, "utf8");
  if (!/database system was shut down at/.test(serverLog) || /automatic recovery|was interrupted|not properly shut down/.test(serverLog)) {
    fail(`template was NOT shut down cleanly (server needed crash recovery on first open):\n${serverLog}`);
  }
  const summary = await assertCleanSeed(databaseUrl(port), { expectTenantId: manifest.tenantId });
  const seq = await withClient(databaseUrl(port), (c) => c.query("SELECT count(*)::int AS n FROM document_sequences"));
  if (seq.rows[0].n !== 0) fail("document_sequences is not empty");
  if (summary.migrationsApplied !== manifest.migrations.applied) fail("migration count differs from manifest");
  if (summary.licenseKey !== manifest.license.key) fail("license key differs from manifest");
  log(
    `PASS — ${summary.migrationsApplied}/${summary.journalEntries} migrations, ${summary.tableCount} tables, non-empty: ${JSON.stringify(summary.nonEmpty)}, document_sequences=0`,
  );
} finally {
  if (started) {
    try {
      stopPostgresClean(copy);
    } catch {
      /* ignore */
    }
  }
  rmSync(work, { recursive: true, force: true });
}
