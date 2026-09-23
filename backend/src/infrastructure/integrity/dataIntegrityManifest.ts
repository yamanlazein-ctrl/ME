/**
 * REPAIR-023 — data-integrity manifest helpers (desktop).
 * Collects row counts, evaluates severe drops, and reads/writes the manifest file.
 */
import { readFile, writeFile, rename, mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { existsSync } from "node:fs";
import { logger } from "../config/logger.js";
import { config } from "../config/env.js";

export type IntegrityCounts = {
  tenants: number;
  users: number;
  parties: number;
  invoices: number;
  invoiceLines: number;
  rolls: number;
  ledgerEntries: number;
  vouchers: number;
  returns: number;
  syncOutboxPending: number;
};

export type DataIntegrityManifest = {
  version: 1;
  installationId: string;
  tenantId: string;
  schemaJournalIdx: number;
  lastKnownCounts: IntegrityCounts;
  lastKnownDatabaseSizeBytes: number;
  lastVerifiedAt: string;
  lastSuccessfulBackupAt: string | null;
  lastBootDecision: string;
  resetAuthorized: boolean;
  restoreInProgress: { operationId: string; expectedCounts: IntegrityCounts } | null;
};

/** Tables whose drop triggers SAFE_MODE (§19 Q17). */
export const DROP_CHECK_KEYS = [
  "invoices",
  "parties",
  "rolls",
  "ledgerEntries",
  "vouchers",
] as const;

export function evaluateDrop(
  prev: IntegrityCounts,
  now: IntegrityCounts,
): { severe: boolean; drops: Array<{ key: string; prev: number; now: number }> } {
  const drops: Array<{ key: string; prev: number; now: number }> = [];
  for (const key of DROP_CHECK_KEYS) {
    const p = prev[key] ?? 0;
    const n = now[key] ?? 0;
    if (p <= 0) continue;
    const absDrop = p - n;
    if (absDrop <= 0) continue;
    const threshold = Math.max(20, Math.ceil(p * 0.1));
    if (absDrop > threshold) {
      drops.push({ key, prev: p, now: n });
    }
  }
  return { severe: drops.length > 0, drops };
}

export function manifestPath(): string | null {
  return process.env.DATA_INTEGRITY_PATH?.trim() || null;
}

export async function readManifest(): Promise<DataIntegrityManifest | null> {
  const path = manifestPath();
  if (!path || !existsSync(path)) return null;
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as DataIntegrityManifest;
  } catch (err) {
    logger.warn({ err }, "MANIFEST_UNREADABLE");
    return null;
  }
}

export async function writeManifestAtomic(manifest: DataIntegrityManifest): Promise<void> {
  const path = manifestPath();
  if (!path) return;
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.tmp`;
  const body = `${JSON.stringify(manifest, null, 2)}\n`;
  await writeFile(tmp, body, "utf8");
  await rename(tmp, path);
  // Mirror under logs/ so deleting one file is not enough.
  const mirrorDir = join(dirname(path), "logs");
  try {
    await mkdir(mirrorDir, { recursive: true });
    await writeFile(join(mirrorDir, "data-integrity.last.json"), body, "utf8");
  } catch {
    /* best-effort mirror */
  }
}

type Queryable = {
  query: (text: string, values?: unknown[]) => Promise<{ rows: Array<Record<string, unknown>> }>;
};

export async function collectCounts(
  db: Queryable,
  tenantId: string,
): Promise<{ counts: IntegrityCounts; databaseSizeBytes: number }> {
  const r = await db.query(
    `SELECT
       (SELECT count(*)::int FROM tenants) AS tenants,
       (SELECT count(*)::int FROM users WHERE tenant_id = $1) AS users,
       (SELECT count(*)::int FROM parties WHERE tenant_id = $1) AS parties,
       (SELECT count(*)::int FROM invoices WHERE tenant_id = $1) AS invoices,
       (SELECT count(*)::int FROM invoice_lines WHERE tenant_id = $1) AS "invoiceLines",
       (SELECT count(*)::int FROM rolls WHERE tenant_id = $1) AS rolls,
       (SELECT count(*)::int FROM ledger_entries WHERE tenant_id = $1) AS "ledgerEntries",
       (SELECT count(*)::int FROM vouchers WHERE tenant_id = $1) AS vouchers,
       (SELECT count(*)::int FROM returns WHERE tenant_id = $1) AS returns,
       (SELECT count(*)::int FROM sync_outbox WHERE tenant_id = $1 AND status IN ('pending','pushing')) AS "syncOutboxPending",
       (SELECT pg_database_size(current_database()))::bigint AS "databaseSizeBytes"`,
    [tenantId],
  );
  const row = r.rows[0] ?? {};
  const counts: IntegrityCounts = {
    tenants: Number(row.tenants ?? 0),
    users: Number(row.users ?? 0),
    parties: Number(row.parties ?? 0),
    invoices: Number(row.invoices ?? 0),
    invoiceLines: Number(row.invoiceLines ?? 0),
    rolls: Number(row.rolls ?? 0),
    ledgerEntries: Number(row.ledgerEntries ?? 0),
    vouchers: Number(row.vouchers ?? 0),
    returns: Number(row.returns ?? 0),
    syncOutboxPending: Number(row.syncOutboxPending ?? 0),
  };
  return { counts, databaseSizeBytes: Number(row.databaseSizeBytes ?? 0) };
}

/** Module-level SAFE_MODE flag set at boot when a severe drop is detected. */
let safeModeActive = false;
let safeModeReason: string | null = null;
let lastComparison: ReturnType<typeof evaluateDrop> | null = null;

export function isDataSafeMode(): boolean {
  return safeModeActive;
}

export function getSafeModeStatus() {
  return {
    safeMode: safeModeActive,
    reason: safeModeReason,
    comparison: lastComparison,
    desktop: Boolean(config.DESKTOP_DEPLOY),
  };
}

export function enterSafeMode(reason: string, comparison?: ReturnType<typeof evaluateDrop>): void {
  safeModeActive = true;
  safeModeReason = reason;
  lastComparison = comparison ?? null;
  logger.fatal({ reason, comparison, bootId: process.env.MOTARD_BOOT_ID }, "DATA_SAFE_MODE");
}

export function acceptBaseline(): void {
  safeModeActive = false;
  safeModeReason = null;
  lastComparison = null;
  logger.warn({ bootId: process.env.MOTARD_BOOT_ID }, "BASELINE_ACCEPTED");
}

export async function verifyDataAgainstManifest(
  db: Queryable,
  tenantId: string,
): Promise<void> {
  if (!config.DESKTOP_DEPLOY) return;
  const manifest = await readManifest();
  if (!manifest) {
    if (process.env.DATA_INTEGRITY_PATH && existsSync(process.env.DATA_INTEGRITY_PATH)) {
      enterSafeMode("MANIFEST_UNREADABLE");
    }
    return; // first install only when no manifest path/file exists
  }
  if (manifest.resetAuthorized) return;
  const expected =
    manifest.restoreInProgress?.expectedCounts ?? manifest.lastKnownCounts;
  const { counts, databaseSizeBytes } = await collectCounts(db, tenantId);
  const comparison = evaluateDrop(expected, counts);
  if (comparison.severe) {
    enterSafeMode("severe_data_drop", comparison);
    return;
  }
  // Refresh manifest on healthy boot.
  await writeManifestAtomic({
    ...manifest,
    tenantId,
    lastKnownCounts: counts,
    lastKnownDatabaseSizeBytes: databaseSizeBytes,
    lastVerifiedAt: new Date().toISOString(),
    lastBootDecision: "REUSE",
    resetAuthorized: false,
    restoreInProgress: null,
  });
}
