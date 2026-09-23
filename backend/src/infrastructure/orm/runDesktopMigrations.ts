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

/** Anything with `query` — a pg Pool, Client or PoolClient (lets tests run the repair inside a rolled-back transaction). */
type Queryable = { query: (text: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }> };

/**
 * Legacy-data repair that MUST run before migration DFP-013 (composite tenant/license foreign keys).
 *
 * Older builds created licenses with `tenant_id = NULL` (a license existed before it was bound to a company) and
 * devices registered against them. DFP-013 refuses to add the tenant/license foreign key while such rows exist
 * ("device_registrations has license rows with NULL or mismatched tenant_id — fix data before applying") — on a
 * desktop that refusal is a boot crash with no way out for the customer.
 *
 * The repair is deterministic and lossless: an orphan license whose registered devices all belong to ONE tenant is
 * claimed by that tenant (the de-facto owner). A license used by devices of several tenants is genuinely
 * ambiguous and is left alone — the migration then still refuses, and the server reports why.
 *
 * Skipped when the foreign key already exists (nothing left to repair) or the tables do not exist yet (fresh
 * cluster). Returns the number of licenses it claimed.
 */
export async function repairLegacyLicenseTenantPairing(db: Queryable): Promise<number> {
  const state = await db.query(
    `SELECT to_regclass('public.licenses') IS NOT NULL
        AND to_regclass('public.device_registrations') IS NOT NULL AS tables_exist,
            EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'device_registrations_tenant_license_fk') AS fk_exists`,
  );
  const { tables_exist: tablesExist, fk_exists: fkExists } = state.rows[0] ?? {};
  if (!tablesExist || fkExists) return 0;

  const claimed = await db.query(
    `UPDATE licenses AS l
        SET tenant_id = d.tenant_id
       FROM (
              SELECT license_id, (array_agg(DISTINCT tenant_id))[1] AS tenant_id
                FROM device_registrations
               GROUP BY license_id
              HAVING count(DISTINCT tenant_id) = 1
            ) AS d
      WHERE l.id = d.license_id
        AND l.tenant_id IS NULL`,
  );
  const n = claimed.rowCount ?? 0;
  if (n > 0) {
    logger.warn(
      { licenses: n },
      "Legacy data repaired: unowned licenses were assigned to the tenant whose devices already use them",
    );
  }
  return n;
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
 * baseline *every* journal entry (not only the latest) so migrate() does not
 * replay CREATE TABLE. Baselining only the latest hash used to skip
 * intermediate migrations whose DDL was never applied. Baked templates must
 * therefore be built from a fully migrated cluster; this runner intentionally
 * has no ad-hoc schema repair path.
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
    logger.warn(
      { count: files.length },
      "Desktop cluster has schema but no drizzle history — baselining full journal; ensureDesktopSchema must close gaps",
    );
    for (const file of files) {
      await pool.query(
        `INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
         SELECT $1, $2
         WHERE NOT EXISTS (
           SELECT 1 FROM drizzle.__drizzle_migrations WHERE hash = $1
         )`,
        [file.hash, file.folderMillis],
      );
    }
  }

  await repairLegacyLicenseTenantPairing(pool);
  await migrate(db, { migrationsFolder: folder });
  await stampDbMeta(folder);
}
