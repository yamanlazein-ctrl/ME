// Phase F (D-006) — live RLS verification.
//
// Connects with DATABASE_URL (or --url / ADMIN_DATABASE_URL), reads the
// catalog, and FAILS (exit 1) unless the database satisfies the RLS contract:
//
//   1. every public base table except the exempt bookkeeping tables
//      (schema_migrations, __drizzle_migrations) has relrowsecurity = true;
//   2. every RLS-enabled table has at least one policy;
//   3. the canonical policy families exist with their expected table counts
//      (tenant_isolation x29, platform_or_tenant x8, tenant_directory x1,
//      platform_only x1 — the E-2 verified state);
//   4. the app_user runtime role does NOT have BYPASSRLS (when the role exists).
//
// Wired into: `db:push:scratch` (post-push guard), CI (post-migrate step).
//
// Usage:
//   node scripts/verify-rls.mjs
//   node scripts/verify-rls.mjs --url postgresql://user:pass@host:5432/db

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));

// --- load DATABASE_URL: --url flag > env DATABASE_URL > backend/.env --------
function loadEnvUrl() {
  if (process.env.DATABASE_URL) return process.env.DATABASE_URL;
  try {
    const env = readFileSync(join(here, "..", ".env"), "utf8");
    const m = env.match(/^\s*DATABASE_URL\s*=\s*"?([^"\r\n]+)"?\s*$/m);
    if (m) return m[1].trim();
  } catch {
    /* .env optional */
  }
  return null;
}

const flagIdx = process.argv.indexOf("--url");
const url = flagIdx !== -1 ? process.argv[flagIdx + 1] : loadEnvUrl();
if (!url) {
  console.error("verify-rls: no DATABASE_URL (env, --url, or backend/.env) — cannot verify.");
  process.exit(1);
}

/**
 * Internal bookkeeping tables intentionally NOT RLS-managed (D-006).
 *
 * `revoked_tokens` (P0-004) is platform-level security bookkeeping that must be
 * readable *before* a tenant context exists — the auth middleware checks every
 * bearer token, including on routes that resolve the tenant from the token
 * itself. A tenant-scoped policy would hide the row on those checkouts and the
 * revocation would silently fail. See revoked-token.table.ts.
 */
const EXEMPT = new Set(["schema_migrations", "__drizzle_migrations", "revoked_tokens"]);

/**
 * Canonical policy family → expected table count.
 *
 * These counts are the VERIFIED runtime state produced by applying
 * `src/infrastructure/orm/rls/enable-rls.sql` to a database that has run all
 * migrations, and were re-measured after the six sync tables
 * (sync_devices / sync_outbox / sync_inbox / sync_resource_claims /
 * sync_state / document_number_blocks) were added to the tenant-scoped
 * family:
 *
 *   tenant_isolation   = 37 array entries - 1 (party_balances is dropped by
 *                        0038_drop_party_balances) = 36
 *                        (36 = 34 + sync_tombstones + sync_conflicts, added to
 *                        the canonical family by 20260914_sync_rls_canonical_policies)
 *   platform_or_tenant = 8
 *   tenant_directory   = 1   (tenants)
 *   platform_only      = 1   (system_admins)
 *   total              = 46 RLS-enabled business tables, each with exactly
 *                        one canonical policy.
 *
 * Proof command (repeat whenever the policy layer changes):
 *   select policyname, count(*) from pg_policies
 *   where schemaname='public' group by 1;
 */
const EXPECTED_POLICIES = {
  tenant_isolation: 36,
  platform_or_tenant: 8,
  tenant_directory: 1,
  platform_only: 1,
};

const violations = [];
const client = new pg.Client({ connectionString: url });

try {
  await client.connect();

  // 1 + 2: relrowsecurity and policy presence for every business table.
  const { rows: tableRows } = await client.query(`
    SELECT c.relname AS table_name,
           c.relrowsecurity AS rls,
           EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname = 'public' AND p.tablename = c.relname) AS has_policy
    FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE n.nspname = 'public' AND c.relkind = 'r'
    ORDER BY c.relname
  `);

  const business = tableRows.filter((r) => !EXEMPT.has(r.table_name));
  if (business.length === 0) {
    violations.push("no business tables found — did migrations/push run on this database?");
  }
  for (const r of business) {
    if (!r.rls) violations.push(`RLS not enabled on table: ${r.table_name}`);
    if (r.rls && !r.has_policy) violations.push(`RLS enabled but NO policy on table: ${r.table_name}`);
  }
  const unprotectedExempt = tableRows.filter((r) => EXEMPT.has(r.table_name) && r.rls);
  for (const r of unprotectedExempt) violations.push(`exempt table unexpectedly RLS-enabled: ${r.table_name}`);

  // 3: canonical policy families and their counts.
  const { rows: policyRows } = await client.query(`
    SELECT policyname, count(*)::int AS tables
    FROM pg_policies
    WHERE schemaname = 'public'
    GROUP BY policyname
    ORDER BY policyname
  `);
  const byName = Object.fromEntries(policyRows.map((r) => [r.policyname, r.tables]));
  for (const [name, expected] of Object.entries(EXPECTED_POLICIES)) {
    const actual = byName[name] ?? 0;
    if (actual !== expected) {
      violations.push(`policy family ${name}: expected ${expected} tables, found ${actual}`);
    }
  }
  const unknown = policyRows.filter((r) => !(r.policyname in EXPECTED_POLICIES));
  for (const r of unknown) violations.push(`unexpected policy in public schema: ${r.policyname} (${r.tables} tables)`);

  // 4: runtime role must not bypass RLS.
  const { rows: roleRows } = await client.query(
    `SELECT rolbypassrls FROM pg_roles WHERE rolname = 'app_user'`,
  );
  if (roleRows.length > 0 && roleRows[0].rolbypassrls) {
    violations.push("role app_user has BYPASSRLS — runtime role must be NOBYPASSRLS");
  }

  if (violations.length > 0) {
    console.error("\nverify-rls: RLS CONTRACT VIOLATED");
    for (const v of violations) console.error(`  - ${v}`);
    console.error(
      `\nFix: re-apply src/infrastructure/orm/rls/enable-rls.sql as the table owner\n` +
        `(node scripts/apply-rls.mjs, or psql -f .../enable-rls.sql), then re-run this check.`,
    );
    process.exitCode = 1;
  } else {
    console.log(
      `verify-rls: OK — ${business.length} business tables RLS-enabled with policies; ` +
        `policy families: ${Object.entries(EXPECTED_POLICIES)
          .map(([n, c]) => `${n}=${c}`)
          .join(", ")}; app_user NOBYPASSRLS.`,
    );
  }
} catch (err) {
  console.error(`verify-rls: check failed — ${err.message}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
