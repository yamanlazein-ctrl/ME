import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";
import { logger } from "../config/logger.js";

export function shouldBaselineExistingCluster(
  hasTenantsTable: boolean,
  drizzleRowCount: number,
): boolean {
  return hasTenantsTable && drizzleRowCount === 0;
}

export function resolveMigrationsFolder(
  envFolder = process.env.DESKTOP_MIGRATIONS_FOLDER,
  cwd = process.cwd(),
): string {
  const candidates = [
    envFolder,
    path.join(cwd, "src", "infrastructure", "orm", "migrations"),
    path.join(cwd, "dist", "backend", "src", "infrastructure", "orm", "migrations"),
  ].filter((p): p is string => Boolean(p && p.trim()));

  for (const folder of candidates) {
    if (existsSync(path.join(folder, "meta", "_journal.json"))) {
      return folder;
    }
  }
  throw new Error(
    `مجلد هجرات Drizzle غير موجود (DESKTOP_MIGRATIONS_FOLDER / src/infrastructure/orm/migrations). جرّبت: ${candidates.join(", ")}`,
  );
}

export function lastJournalIdx(migrationsFolder: string): number {
  const raw = JSON.parse(
    readFileSync(path.join(migrationsFolder, "meta", "_journal.json"), "utf8"),
  ) as { entries?: Array<{ idx: number }> };
  const entries = raw.entries ?? [];
  return entries.length ? entries[entries.length - 1]!.idx : 0;
}

async function stampDbMeta(migrationsFolder: string): Promise<void> {
  const metaPath = process.env.DESKTOP_DB_META_PATH;
  if (!metaPath) return;
  try {
    const raw = await readFile(metaPath, "utf8");
    const meta = JSON.parse(raw) as Record<string, unknown>;
    meta.schema_journal_idx = lastJournalIdx(migrationsFolder);
    await writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
  } catch (err) {
    logger.warn({ err, metaPath }, "Could not stamp db-meta.json schema_journal_idx");
  }
}

/**
 * Desktop boot migrator (P0-1). Runs before listen.
 *
 * Empty cluster: drizzle migrate() applies the full journal in one transaction.
 * Copied-forward cluster that already has `tenants` but no drizzle history:
 * baseline the latest journal hash so we do not replay CREATE TABLE from 0001,
 * then migrate() applies only newer files (higher `when`).
 */
export async function runDesktopMigrations(): Promise<void> {
  const folder = resolveMigrationsFolder();
  const { db, pool } = await import("./drizzle.js");

  const tenants = await pool.query<{ t: string | null }>(
    `SELECT to_regclass('public.tenants') AS t`,
  );
  const hasTenants = Boolean(tenants.rows[0]?.t);

  await pool.query(`CREATE SCHEMA IF NOT EXISTS drizzle`);
  await pool.query(`
    CREATE TABLE IF NOT EXISTS drizzle.__drizzle_migrations (
      id SERIAL PRIMARY KEY,
      hash text NOT NULL,
      created_at bigint
    )
  `);
  const counted = await pool.query<{ n: number }>(
    `SELECT count(*)::int AS n FROM drizzle.__drizzle_migrations`,
  );
  const drizzleRowCount = counted.rows[0]?.n ?? 0;

  if (shouldBaselineExistingCluster(hasTenants, drizzleRowCount)) {
    const files = readMigrationFiles({ migrationsFolder: folder });
    const last = files[files.length - 1];
    if (last) {
      logger.warn(
        { hash: last.hash, folderMillis: last.folderMillis },
        "Desktop cluster has schema but no drizzle history — baselining latest journal entry",
      );
      await pool.query(
        `INSERT INTO drizzle.__drizzle_migrations (hash, created_at) VALUES ($1, $2)`,
        [last.hash, last.folderMillis],
      );
    }
  }

  await migrate(db, { migrationsFolder: folder });
  await stampDbMeta(folder);
}
