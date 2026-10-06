/**
 * Production backup / restore on a STOPPED device's SQLite file (sync harness, T110). The restore
 * is the same call the desktop's startup "restore a backup" choice makes (runDesktopMigrations →
 * restoreBackupV3 with skipSafetyBackup), so the restore-on-synced marker is written exactly as in
 * the field.
 *
 *   (cwd: backend, env: DB_ENGINE=sqlite SQLITE_PATH=<db>)
 *   node backend/node_modules/tsx/dist/cli.mjs scripts/parity/lib/sqliteBackupRestore.mts backup
 *   node backend/node_modules/tsx/dist/cli.mjs scripts/parity/lib/sqliteBackupRestore.mts restore <archive>
 * Prints one JSON line.
 */
import { ensureSqliteRuntime, shutdownSqliteRuntime } from "../../../backend/src/infrastructure/orm/sqlite/runtime.js";
import { createAndVerifyBackup } from "../../../backend/src/infrastructure/backup/sqliteBackup.js";
import { restoreBackupV3 } from "../../../backend/src/infrastructure/backup/sqliteRestore.js";

process.env.MOTARD_STARTUP_STATE ??= "OPEN_EXISTING";
const [mode, archive] = process.argv.slice(2);
await ensureSqliteRuntime();
try {
  if (mode === "backup") {
    const b = await createAndVerifyBackup({ kind: "manual" });
    console.log(JSON.stringify({ path: b.path, sha256: b.sha256 }));
  } else if (mode === "restore" && archive) {
    const r = await restoreBackupV3(archive, { skipSafetyBackup: true });
    console.log(JSON.stringify({ dataId: r.dataId, migrated: r.migrated }));
  } else {
    throw new Error("usage: sqliteBackupRestore.mts backup | restore <archive>");
  }
} finally {
  shutdownSqliteRuntime();
}
process.exit(0);
