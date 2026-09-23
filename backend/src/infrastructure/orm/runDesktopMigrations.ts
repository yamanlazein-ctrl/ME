import { existsSync, readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { migrate } from "drizzle-orm/node-postgres/migrator";
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
  const { config } = await import("../config/env.js");

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
  const journalIdx = lastJournalIdx(folder);

  // REPAIR-025: legacy baseline only when full fingerprint matches.
  if (shouldBaselineExistingCluster(hasTenants, drizzleRowCount)) {
    const { loadCommittedFingerprint, readLiveFingerprint, diffFingerprint } =
      await import("./schemaFingerprint.js");
    const expected = loadCommittedFingerprint(folder);
    if (!expected) {
      logger.fatal(
        { bootId: process.env.MOTARD_BOOT_ID },
        "[FATAL] SCHEMA_UNVERIFIED: no committed schema fingerprint — baselining refused.",
      );
      throw new Error("SCHEMA_UNVERIFIED: missing schema-fingerprint.json");
    }
    const live = await readLiveFingerprint(pool);
    const diff = diffFingerprint(expected, live);
    if (diff.missing.length || diff.changed.length) {
      const { takePreOpSnapshot } = await import("../integrity/snapshot.js");
      await takePreOpSnapshot({
        databaseUrl: config.DATABASE_URL,
        operation: "migrate",
        operationId: process.env.MOTARD_BOOT_ID ?? `boot-${Date.now()}`,
        schemaJournalIdx: journalIdx,
      });
      logger.fatal(
        { bootId: process.env.MOTARD_BOOT_ID, diff },
        "[FATAL] SCHEMA_UNVERIFIED: legacy cluster fingerprint mismatch",
      );
      throw new Error("SCHEMA_UNVERIFIED: fingerprint mismatch — baselining refused");
    }
    // Fingerprint matches — safe to baseline full journal (REPAIR-025).
    const { readMigrationFiles } = await import("drizzle-orm/migrator");
    const files = readMigrationFiles({ migrationsFolder: folder });
    for (const file of files) {
      await pool.query(
        `INSERT INTO drizzle.__drizzle_migrations (hash, created_at)
         SELECT $1, $2
         WHERE NOT EXISTS (SELECT 1 FROM drizzle.__drizzle_migrations WHERE hash = $1)`,
        [file.hash, file.folderMillis],
      );
    }
    logger.warn(
      { count: files.length, bootId: process.env.MOTARD_BOOT_ID },
      "SCHEMA fingerprint matched — baselined full journal (REPAIR-025)",
    );
  }

  // REPAIR-024: snapshot when pending migrations exist.
  const metaPath = process.env.DESKTOP_DB_META_PATH;
  let currentIdx = 0;
  if (metaPath && existsSync(metaPath)) {
    try {
      const meta = JSON.parse(await readFile(metaPath, "utf8")) as { schema_journal_idx?: number };
      currentIdx = Number(meta.schema_journal_idx ?? 0);
    } catch {
      /* ignore */
    }
  }
  if (journalIdx > currentIdx && hasTenants) {
    const { takePreOpSnapshot } = await import("../integrity/snapshot.js");
    const snap = await takePreOpSnapshot({
      databaseUrl: config.DATABASE_URL,
      operation: "migrate",
      operationId: process.env.MOTARD_BOOT_ID ?? `boot-${Date.now()}`,
      schemaJournalIdx: currentIdx,
    });
    if (!snap.ok) {
      throw new Error(snap.reason);
    }
  }

  logger.info(
    { bootId: process.env.MOTARD_BOOT_ID, folder },
    "MIGRATION_STARTED",
  );
  try {
    const repairSnapNeeded = true;
    if (repairSnapNeeded && hasTenants) {
      const { takePreOpSnapshot } = await import("../integrity/snapshot.js");
      // Snapshot before legacy repair (idempotent if already taken this boot — retention handles dupes)
      await takePreOpSnapshot({
        databaseUrl: config.DATABASE_URL,
        operation: "legacy_repair",
        operationId: `${process.env.MOTARD_BOOT_ID ?? "boot"}-legacy`,
        schemaJournalIdx: currentIdx,
      });
    }
    await repairLegacyLicenseTenantPairing(pool);
    await migrate(db, { migrationsFolder: folder });

    // REPAIR-025: verify fingerprint after migrate (desktop strict).
    if (config.DESKTOP_DEPLOY) {
      const { loadCommittedFingerprint, readLiveFingerprint, diffFingerprint } =
        await import("./schemaFingerprint.js");
      const expected = loadCommittedFingerprint(folder);
      if (expected) {
        const live = await readLiveFingerprint(pool);
        const diff = diffFingerprint(expected, live);
        if (diff.missing.length || diff.changed.length) {
          logger.fatal(
            { bootId: process.env.MOTARD_BOOT_ID, diff },
            "[FATAL] SCHEMA_UNVERIFIED after migrate",
          );
          throw new Error("SCHEMA_UNVERIFIED: post-migrate fingerprint mismatch");
        }
        if (diff.extra.length) {
          logger.warn({ extra: diff.extra }, "schema fingerprint extras (ignored)");
        }
      }
    }

    await stampDbMeta(folder);
    logger.info({ bootId: process.env.MOTARD_BOOT_ID }, "MIGRATION_OK");
  } catch (err) {
    logger.fatal({ err, bootId: process.env.MOTARD_BOOT_ID }, "MIGRATION_FAILED");
    throw err;
  }
}
