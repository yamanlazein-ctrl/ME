/**
 * Lazy access to the PostgreSQL layer (specs/001-desktop-sqlite-engine FR-040): modules that also
 * run in a DB_ENGINE=sqlite process must not import drizzle.ts statically (it opens a pg Pool and
 * now refuses to load under SQLite). They resolve the PG handle on first use instead — the same
 * pool and handle as before, only evaluated later.
 */
type PgModule = typeof import("./drizzle.js");
let mod: Promise<PgModule> | null = null;

export function pgModule(): Promise<PgModule> {
  mod ??= import("./drizzle.js");
  return mod;
}

export async function pgDb(): Promise<PgModule["db"]> {
  return (await pgModule()).db;
}

export async function pgPool(): Promise<PgModule["pool"]> {
  return (await pgModule()).pool;
}
