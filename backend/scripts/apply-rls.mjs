// Apply the canonical RLS policy layer (src/infrastructure/orm/rls/enable-rls.sql).
//
// Why this script exists: `enable-rls.sql` is the project's canonical policy
// layer — the file that rls-guard.test.ts checks every TS business table
// against, and that verify-rls.mjs expects to have been applied. It is NOT a
// drizzle migration, so `db:migrate` never runs it. Without this script the
// documented remediation ("re-apply ... enable-rls.sql") had no executable
// path: psql is not available in the packaged desktop runtime, and
// verify-rls.mjs pointed at a file that did not exist.
//
// Idempotent: enable-rls.sql drops and recreates its policies, and its
// legacy-policy cleanup only removes policies on tables that already carry a
// canonical one. Safe to run after every migrate.
//
// Usage:
//   node scripts/apply-rls.mjs
//   node scripts/apply-rls.mjs --url postgresql://user:pass@host:5432/db
//
// Then verify:
//   node scripts/verify-rls.mjs

import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";

const here = dirname(fileURLToPath(import.meta.url));
const RLS_SQL_PATH = join(here, "..", "src", "infrastructure", "orm", "rls", "enable-rls.sql");

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
  console.error("apply-rls: no DATABASE_URL (env, --url, or backend/.env) — cannot apply.");
  process.exit(1);
}

let sql;
try {
  sql = readFileSync(RLS_SQL_PATH, "utf8");
} catch (err) {
  console.error(`apply-rls: cannot read ${RLS_SQL_PATH} — ${err.message}`);
  process.exit(1);
}

const client = new pg.Client({ connectionString: url });
try {
  await client.connect();
  await client.query(sql);
  console.log("apply-rls: applied src/infrastructure/orm/rls/enable-rls.sql");
  console.log("apply-rls: next — node scripts/verify-rls.mjs");
} catch (err) {
  console.error(`apply-rls: FAILED — ${err.message}`);
  if (err.position) console.error(`  at statement position ${err.position}`);
  process.exitCode = 1;
} finally {
  await client.end().catch(() => {});
}
