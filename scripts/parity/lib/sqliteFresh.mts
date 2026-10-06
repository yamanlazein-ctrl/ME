/**
 * Create one fresh, fully migrated SQLite company database through the production boot path
 * (`bootSqlite` with startup state FRESH), then close it. Used by the sync harness (T102/T103) to
 * prepare device databases before seeding them.
 *
 *   node backend/node_modules/tsx/dist/cli.mjs scripts/parity/lib/sqliteFresh.mts <path>   (cwd: backend)
 */
import { bootSqlite, resolveSqliteMigrationsFolder } from "../../../backend/src/infrastructure/orm/sqlite/runtime.js";
import { closeSqlite } from "../../../backend/src/infrastructure/orm/sqlite/connection.js";

const path = process.argv[2];
if (!path) {
  console.error("usage: sqliteFresh.mts <database path>");
  process.exit(2);
}
const booted = bootSqlite({ path, migrationsDir: resolveSqliteMigrationsFolder(), startupState: "FRESH" });
closeSqlite(booted.conns);
console.log(`[sqliteFresh] created ${path} (schema ${booted.meta.schema_journal_idx})`);
