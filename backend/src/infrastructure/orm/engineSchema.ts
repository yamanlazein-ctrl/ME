/**
 * Engine-resolved Drizzle handle and tables for small shared infrastructure modules
 * (specs/001-desktop-sqlite-engine S4): token denylist, session cutoff, licensing, installation.
 *
 * The SQLite schema mirrors the PG schema with the same export names and identical row types
 * (tests/sqlite/schema-type-parity.test.ts), and Drizzle's builder API is the same on both, so these
 * modules keep ONE query source typed against PG and run it on the engine's own handle + tables.
 * Nothing here is evaluated until first use, so a SQLite process never loads the PG layer.
 */
import { getEngine } from "./engine.js";

type PgSchema = typeof import("./schemas/index.js");
type PgDb = import("./drizzle.js").DB;

/** The engine's table objects (PG-typed; the SQLite tables are type-identical). */
export async function engineSchema(): Promise<PgSchema> {
  if (getEngine() === "sqlite") return (await import("./sqlite/schemas/index.js")) as unknown as PgSchema;
  return import("./schemas/index.js");
}

/** The engine's default handle: PG `db`, or the ambient SQLite handle (transaction-aware). */
export async function engineDb(): Promise<PgDb> {
  if (getEngine() === "sqlite") return (await import("./sqlite/drizzleCompat.js")).db as unknown as PgDb;
  return (await import("./drizzle.js")).db;
}
