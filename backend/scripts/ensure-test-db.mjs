/**
 * Provision the local test database that `backend/vitest.config.ts` points at.
 *
 * WHY THIS EXISTS
 * ---------------
 * `vitest.config.ts` loads `.env.test`, whose `DATABASE_URL` targets
 * `erp_test`. Nothing in the repo ever created that database, so a fresh
 * checkout produced this for every DB-backed suite:
 *
 *     error: database "erp_test" does not exist        (SQLSTATE 3D000)
 *
 * That is not a red test — it is a missing prerequisite, and it silently
 * reduced the suite to the DB-free guards only (11 of 42 files failing on
 * setup, with the real signal buried in connection errors).
 *
 * WHAT IT DOES
 * ------------
 *  1. resolves the test `DATABASE_URL` (from `.env.test`, else `.env`),
 *  2. creates the database when it is missing (idempotent),
 *  3. applies every committed migration with drizzle-orm's own migrator —
 *     the same code path `drizzle-kit migrate` uses, but with the failure
 *     surfaced on stderr instead of swallowed by the CLI's progress view.
 *
 * Usage:  npm run db:test:setup
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";

const here = path.dirname(fileURLToPath(import.meta.url));
const backendRoot = path.join(here, "..");

// Same precedence as vitest.config.ts: .env.test wins, .env fills the gaps.
dotenv.config({ path: path.join(backendRoot, ".env.test"), override: true });
dotenv.config({ path: path.join(backendRoot, ".env") });

const url = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/erp_test";
const migrationsFolder = path.join(backendRoot, "src", "infrastructure", "orm", "migrations");

let target;
try {
  target = new URL(url);
} catch {
  console.error(`DATABASE_URL is not a valid URL: ${url}`);
  process.exit(1);
}

const dbName = target.pathname.replace(/^\//, "");
if (!dbName) {
  console.error(`DATABASE_URL has no database name: ${url}`);
  process.exit(1);
}

/** Connect to the maintenance DB on the same server to CREATE the target. */
async function ensureDatabaseExists() {
  const admin = new URL(target.toString());
  admin.pathname = "/postgres";
  const client = new pg.Client({ connectionString: admin.toString(), connectionTimeoutMillis: 10_000 });
  try {
    await client.connect();
    const exists = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [dbName]);
    if (exists.rowCount === 0) {
      // Identifiers cannot be parameterised; dbName comes from our own
      // DATABASE_URL, and is quoted to keep it safe.
      await client.query(`CREATE DATABASE "${dbName.replace(/"/g, '""')}"`);
      console.log(`created database ${dbName}`);
    } else {
      console.log(`database ${dbName} already exists`);
    }
  } finally {
    await client.end().catch(() => {});
  }
}

async function applyMigrations() {
  const pool = new pg.Pool({ connectionString: url, max: 1 });
  try {
    const db = drizzle(pool);
    await migrate(db, { migrationsFolder });
    const tables = await pool.query(
      "SELECT count(*)::int AS n FROM information_schema.tables WHERE table_schema = 'public'",
    );
    console.log(`migrations applied — ${tables.rows[0].n} tables in public schema of ${dbName}`);
  } finally {
    await pool.end().catch(() => {});
  }
}

try {
  await ensureDatabaseExists();
  await applyMigrations();
  console.log(`test database ready: ${dbName}`);
} catch (e) {
  console.error("test database setup FAILED:", e instanceof Error ? e.message : e);
  if (e && typeof e === "object" && "cause" in e && e.cause) {
    console.error("cause:", e.cause instanceof Error ? e.cause.message : e.cause);
  }
  process.exitCode = 1;
}