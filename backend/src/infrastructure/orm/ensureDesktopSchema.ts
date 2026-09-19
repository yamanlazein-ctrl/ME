import { runDesktopMigrations } from "./runDesktopMigrations.js";

/**
 * @deprecated Desktop schema changes are owned exclusively by Drizzle's
 * migration journal. Keep this compatibility entry point for older callers,
 * but never execute ad-hoc DDL here. New boot code should call
 * `runDesktopMigrations` directly.
 */
export async function ensureDesktopSchema(_query?: (sql: string) => Promise<unknown>): Promise<void> {
  await runDesktopMigrations();
}
