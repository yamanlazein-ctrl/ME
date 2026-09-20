#!/usr/bin/env node
/**
 * FIN-06: production migration entrypoint.
 *
 * `drizzle-kit migrate` does not reliably surface a failing migration on the
 * production path, so a broken upgrade can present as "it just didn't run".
 * This wrapper drives drizzle-orm's own migrator (the same code path
 * scripts/ensure-test-db.mjs uses), prints the cause on stderr, and exits
 * non-zero so a failed migration can never be mistaken for a no-op.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const BACKEND_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATIONS_FOLDER = join(BACKEND_ROOT, "src", "infrastructure", "orm", "migrations");

function fail(message, cause) {
  process.stderr.write(`[migrate] FAILED: ${message}\n`);
  if (cause) {
    const detail = cause instanceof Error ? (cause.stack ?? cause.message) : String(cause);
    process.stderr.write(`[migrate] cause: ${detail}\n`);
  }
  process.exit(1);
}

const databaseUrl = process.env.DATABASE_URL?.trim();
if (!databaseUrl) fail("DATABASE_URL is not set");

const pool = new pg.Pool({ connectionString: databaseUrl, connectionTimeoutMillis: 10_000 });

try {
  await migrate(drizzle(pool), { migrationsFolder: MIGRATIONS_FOLDER });
  process.stdout.write("[migrate] all migrations applied\n");
} catch (err) {
  fail("migration run did not complete", err);
} finally {
  await pool.end().catch(() => {});
}
