// Replaces backend/src/infrastructure/orm/sqlite/runtime.ts on the phone (Metro file mapping): that file boots a
// database FILE with node:fs/path/url. The phone boots through src/core/runtime.ts (`openRuntime`) before any
// repository is used; shared code that asks "the runtime" gets the one that was opened.
import { getActiveRuntime } from "../core/runtime";

export async function ensureSqliteRuntime() {
  const runtime = getActiveRuntime();
  if (!runtime) throw new Error("SQLITE_NOT_INITIALIZED: openRuntime() has not run");
  return { conns: runtime.conns, created: false, appliedMigrations: runtime.appliedMigrations };
}

export function getSqliteRuntime() {
  const runtime = getActiveRuntime();
  return runtime
    ? { conns: runtime.conns, created: false, appliedMigrations: runtime.appliedMigrations }
    : null;
}

export function shutdownSqliteRuntime(): void {
  // The phone closes through closeRuntime() in src/core/runtime.ts.
}

export function sqliteRuntimeMigrationsDir(): never {
  throw new Error(
    "UNSUPPORTED_ON_PHONE: migrations are bundled (src/core/generated/migrations.ts)",
  );
}
