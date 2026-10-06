/**
 * Desktop backup format v3 (specs/001-desktop-sqlite-engine T092/T093, contracts/backup-format-v3.md).
 *
 * ONE path for every desktop backup (manual, automatic, pre-operation, pre-migration, pre-restore,
 * pre-update): online copy → integrity + FK check → strip device-bound state → VACUUM → zip with a
 * manifest of per-table row counts and hashes → .partial → fsync → rename → fsync(dir) → full
 * verification → registry VERIFIED. Any failure: FAILED, the .partial is removed, the error surfaces.
 * A file is only ever listed as a backup once it has been VERIFIED.
 */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import Database from "better-sqlite3";
import { unzipSync, zipSync, strToU8, strFromU8 } from "fflate";
import { readSqliteFingerprint } from "../orm/sqlite/schemaFingerprint.js";
import { getSqliteRuntime, ensureSqliteRuntime } from "../orm/sqlite/runtime.js";
// (getSqliteRuntime is used by defaultBackupDir)
import { recordBackup, type BackupKind } from "./backupRegistry.js";

export const BACKUP_FORMAT = "motard-erp-backup";
export const BACKUP_FORMAT_VERSION = 3;

/** Device-bound tables (BK-2, FR-042) — NOT v2's DEVICE_BOUND_TABLES, which also drops `licenses`. */
export const EXCLUDED_TABLES = [
  "license_activations",
  "device_registrations",
  "secrets",
  "server_installations",
  "revoked_tokens",
  "idempotency_keys",
  "invitation_codes",
  "license_audit_events",
] as const;

/** Device-bound columns nulled in the copy (each column is nullable; FKs allow NULL). */
export const NULLED_COLUMNS: Record<string, string[]> = {
  licenses: ["binding_type", "binding_value", "offline_token", "offline_token_jti"],
  tenants: ["activation_id"],
  sync_devices: ["device_registration_id"],
};

/** SQLite-only bookkeeping that is not company data (never hashed into the manifest). */
const INTERNAL_TABLES = new Set(["motard_tx_state", "sqlite_sequence"]);

export interface BackupManifestV3 {
  format: typeof BACKUP_FORMAT;
  formatVersion: 3;
  createdAt: string;
  app: { version: string };
  schema: { journalIdx: number; fingerprintSha256: string };
  data: { dataId: string };
  tenant: { id: string | null; name: string | null };
  tables: Array<{ name: string; rows: number; sha256: string }>;
  files: Array<{ path: string; bytes: number; sha256: string }>;
  excludedTables: string[];
  nulledColumns: Record<string, string[]>;
  licence: { licenseId: string; key: string; type: string | null; edition: string | null; plan: string | null; status: string | null } | null;
  sync: { deviceId: string; lastPushedSeq: number | null; lastPulledCursor: number | null } | null;
  kind: BackupKind;
}

export class BackupV3Error extends Error {
  constructor(
    readonly code:
      | "BACKUP_NOT_A_ZIP"
      | "BACKUP_MANIFEST_MISSING"
      | "BACKUP_MANIFEST_HASH_MISMATCH"
      | "BACKUP_FORMAT_UNKNOWN"
      | "BACKUP_POSTGRES_ERA"
      | "BACKUP_NEWER_THAN_APP"
      | "BACKUP_SCHEMA_NEWER_THAN_APP"
      | "BACKUP_DATABASE_MISSING"
      | "BACKUP_FILE_HASH_MISMATCH"
      | "BACKUP_INTEGRITY_FAILED"
      | "BACKUP_FOREIGN_KEYS_FAILED"
      | "BACKUP_TABLE_MISMATCH"
      | "BACKUP_CREATE_FAILED",
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "BackupV3Error";
  }
}

const sha256 = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

function fsyncPath(path: string): void {
  // Windows cannot open a directory for fsync; NTFS metadata (the rename) is journaled.
  try {
    const fd = openSync(path, "r+");
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  } catch {
    if (!statSync(path).isDirectory()) throw new Error(`fsync failed for ${path}`);
  }
}

/** Primary-key column list of a table (rowid when it has no declared PK). */
function pkColumns(db: Database.Database, table: string): string[] {
  const cols = (db.prepare("SELECT name, pk FROM pragma_table_info(?)").all(table) as Array<{ name: string; pk: number }>)
    .filter((c) => c.pk > 0)
    .sort((a, b) => a.pk - b.pk)
    .map((c) => c.name);
  return cols.length ? cols : ["rowid"];
}

/**
 * Canonical content hash of one table: rows ordered by PK, each row a JSON object with sorted keys
 * and stored values (int64 as decimal text so nothing is lost), one row per line.
 */
export function tableDigest(db: Database.Database, table: string): { rows: number; sha256: string } {
  const order = pkColumns(db, table).map((c) => `"${c}"`).join(", ");
  const stmt = db.prepare(`SELECT * FROM "${table}" ORDER BY ${order}`).safeIntegers(true);
  const h = createHash("sha256");
  let rows = 0;
  for (const row of stmt.iterate() as Iterable<Record<string, unknown>>) {
    const canon: Record<string, unknown> = {};
    for (const k of Object.keys(row).sort()) {
      const v = row[k];
      canon[k] = typeof v === "bigint" ? v.toString() : Buffer.isBuffer(v) ? `\\x${v.toString("hex")}` : v;
    }
    h.update(JSON.stringify(canon));
    h.update("\n");
    rows++;
  }
  return { rows, sha256: h.digest("hex") };
}

export function businessTables(db: Database.Database): string[] {
  return (db.prepare("SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").pluck().all() as string[])
    .filter((t) => !INTERNAL_TABLES.has(t));
}

function assertHealthy(db: Database.Database, stage: string): void {
  const ic = db.pragma("integrity_check", { simple: true });
  if (ic !== "ok") throw new BackupV3Error("BACKUP_INTEGRITY_FAILED", `${stage}: integrity_check = ${String(ic)}`);
  const fk = db.pragma("foreign_key_check") as unknown[];
  if (fk.length) throw new BackupV3Error("BACKUP_FOREIGN_KEYS_FAILED", `${stage}: ${fk.length} foreign-key violation(s)`);
}

/** Remove device-bound state from a standalone copy (never from the live database). */
export function stripDeviceBoundState(db: Database.Database): void {
  db.pragma("foreign_keys = OFF");
  // license_audit_events is append-only by trigger; the copy drops and recreates the exact trigger
  // text so the schema (and its fingerprint) stays identical to the live one.
  const triggers = db
    .prepare("SELECT name, sql FROM sqlite_schema WHERE type = 'trigger' AND tbl_name = 'license_audit_events'")
    .all() as Array<{ name: string; sql: string }>;
  db.exec("BEGIN");
  for (const t of triggers) db.exec(`DROP TRIGGER "${t.name}"`);
  for (const [table, cols] of Object.entries(NULLED_COLUMNS)) {
    db.exec(`UPDATE "${table}" SET ${cols.map((c) => `"${c}" = NULL`).join(", ")}`);
  }
  for (const table of EXCLUDED_TABLES) db.exec(`DELETE FROM "${table}"`);
  for (const t of triggers) db.exec(t.sql);
  db.exec("COMMIT");
  db.pragma("foreign_keys = ON");
}

function collectFiles(): Array<{ path: string; data: Uint8Array }> {
  const out: Array<{ path: string; data: Uint8Array }> = [];
  const logoDir = process.env.COMPANY_LOGO_DIR;
  if (logoDir && existsSync(logoDir)) {
    for (const name of readdirSync(logoDir).sort()) {
      const full = join(logoDir, name);
      if (statSync(full).isFile()) out.push({ path: `files/logos/${name}`, data: readFileSync(full) });
    }
  }
  return out;
}

function attachmentFiles(db: Database.Database): Array<{ path: string; data: Uint8Array }> {
  const dir = process.env.ATTACHMENTS_DIR;
  if (!dir || !existsSync(dir)) return [];
  const keys = db.prepare("SELECT storage_key FROM attachments ORDER BY storage_key").pluck().all() as string[];
  const out: Array<{ path: string; data: Uint8Array }> = [];
  for (const key of keys) {
    const full = join(dir, key);
    if (existsSync(full) && statSync(full).isFile()) out.push({ path: `files/attachments/${key.replace(/\\/g, "/")}`, data: readFileSync(full) });
  }
  return out;
}

function readIdentity(db: Database.Database): Pick<BackupManifestV3, "data" | "tenant" | "licence" | "sync" | "schema"> & { journalIdx: number } {
  const meta = db.prepare("SELECT * FROM motard_meta WHERE id = 1").get() as { data_id: string; tenant_id: string | null; schema_journal_idx: number };
  const tenant = (meta.tenant_id
    ? db.prepare("SELECT id, name FROM tenants WHERE id = ?").get(meta.tenant_id)
    : db.prepare("SELECT id, name FROM tenants ORDER BY created_at LIMIT 1").get()) as { id: string; name: string } | undefined;
  const lic = (tenant
    ? db.prepare("SELECT id, key, type, edition, plan, status FROM licenses WHERE tenant_id = ? ORDER BY created_at LIMIT 1").get(tenant.id)
    : undefined) as { id: string; key: string; type: string | null; edition: string | null; plan: string | null; status: string | null } | undefined;
  const device = db.prepare("SELECT id FROM sync_devices ORDER BY created_at LIMIT 1").pluck().get() as string | undefined;
  const pushed = db.prepare("SELECT max(seq) FROM sync_outbox WHERE status = 'synced'").pluck().get() as number | null;
  const pulled = tenant ? (db.prepare("SELECT last_pull_seq FROM sync_state WHERE tenant_id = ?").pluck().get(tenant.id) as number | null | undefined) : null;
  const fp = readSqliteFingerprint(db, meta.schema_journal_idx);
  return {
    journalIdx: meta.schema_journal_idx,
    schema: { journalIdx: meta.schema_journal_idx, fingerprintSha256: sha256(JSON.stringify(fp)) },
    data: { dataId: meta.data_id },
    tenant: { id: tenant?.id ?? null, name: tenant?.name ?? null },
    licence: lic ? { licenseId: lic.id, key: lic.key, type: lic.type, edition: lic.edition, plan: lic.plan, status: lic.status } : null,
    sync: device ? { deviceId: device, lastPushedSeq: pushed ?? null, lastPulledCursor: pulled ?? null } : null,
  };
}

/** Where backups of `kind` go by default: `<root>\backups` (root = data root, parent of data\). */
export function defaultBackupDir(): string {
  const rt = getSqliteRuntime();
  if (!rt) throw new Error("SQLITE_NOT_INITIALIZED");
  return join(dirname(dirname(rt.conns.path)), "backups");
}

export interface CreateBackupOptions {
  kind: BackupKind;
  /** Target directory (default: `<root>\backups`). */
  dir?: string;
  /** File name (default: `<kind>-<timestamp>.zip`). */
  fileName?: string;
  appVersion?: string;
}

export interface CreatedBackup {
  path: string;
  sizeBytes: number;
  sha256: string;
  manifest: BackupManifestV3;
}

/**
 * Steps 2–9 on an existing raw copy (`tmpDb`, produced by step 1 by the caller). Synchronous.
 * `root` is the data root (parent of data\) used for the registry.
 */
function finishBackup(opts: CreateBackupOptions, root: string, dir: string, work: string, tmpDb: string): CreatedBackup {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const finalPath = join(dir, opts.fileName ?? `${opts.kind}-${stamp}.zip`);
  const partial = `${finalPath}.partial`;
  let renamed = false;
  try {
    const copy = new Database(tmpDb);
    let files: Array<{ path: string; data: Uint8Array }>;
    let manifest: BackupManifestV3;
    try {
      copy.pragma("journal_mode = DELETE");
      copy.pragma("foreign_keys = ON");
      // 2. the source copy itself must be sound
      assertHealthy(copy, "source copy");
      // 3. device-bound state out, still sound, compacted
      stripDeviceBoundState(copy);
      assertHealthy(copy, "stripped copy");
      copy.exec("VACUUM");
      const identity = readIdentity(copy);
      files = [...collectFiles(), ...attachmentFiles(copy)];
      manifest = {
        format: BACKUP_FORMAT,
        formatVersion: 3,
        createdAt: new Date().toISOString(),
        app: { version: opts.appVersion ?? process.env.MOTARD_APP_VERSION ?? "0.0.0" },
        schema: identity.schema,
        data: identity.data,
        tenant: identity.tenant,
        tables: businessTables(copy).map((name) => ({ name, ...tableDigest(copy, name) })),
        files: files.map((f) => ({ path: f.path, bytes: f.data.byteLength, sha256: sha256(f.data) })),
        excludedTables: [...EXCLUDED_TABLES],
        nulledColumns: NULLED_COLUMNS,
        licence: identity.licence,
        sync: identity.sync,
        kind: opts.kind,
      };
    } finally {
      copy.close();
    }
    // 4. zip → .partial
    const manifestText = JSON.stringify(manifest, null, 2);
    const entries: Record<string, Uint8Array> = {
      "manifest.json": strToU8(manifestText),
      "manifest.sha256": strToU8(sha256(manifestText)),
      "database.sqlite": readFileSync(tmpDb),
    };
    for (const f of files) entries[f.path] = f.data;
    recordBackup({ path: finalPath, kind: opts.kind, status: "CREATING" }, root);
    writeFileSync(partial, zipSync(entries, { level: 6 }));
    // 5. fsync, 6. rename, 7. fsync(dir)
    fsyncPath(partial);
    renameSync(partial, finalPath);
    renamed = true;
    fsyncPath(dir);
    // 8. verify the file we just wrote, exactly as a restore would
    const verified = openAndVerifyBackupV3Sync(finalPath);
    const bytes = readFileSync(finalPath);
    const created: CreatedBackup = { path: finalPath, sizeBytes: bytes.byteLength, sha256: sha256(bytes), manifest: verified.manifest };
    // 9. registry: VERIFIED
    recordBackup(
      { path: finalPath, kind: opts.kind, status: "VERIFIED", sizeBytes: created.sizeBytes, sha256: created.sha256, manifestSha256: sha256(manifestText), error: undefined },
      root,
    );
    return created;
  } catch (err) {
    rmSync(partial, { force: true });
    // A file that did not reach VERIFIED is never kept under a backup's name.
    if (renamed) rmSync(finalPath, { force: true });
    recordBackup({ path: finalPath, kind: opts.kind, status: "FAILED", error: err instanceof Error ? err.message : String(err) }, root);
    throw err instanceof BackupV3Error ? err : new BackupV3Error("BACKUP_CREATE_FAILED", err instanceof Error ? err.message : String(err));
  }
}

const rootOf = (dbPath: string) => dirname(dirname(dbPath));

/** T092: create, then fully verify, one v3 backup (async online copy). Throws, and records FAILED, on any problem. */
export async function createAndVerifyBackup(opts: CreateBackupOptions): Promise<CreatedBackup> {
  const rt = await ensureSqliteRuntime();
  const root = rootOf(rt.conns.path);
  const dir = opts.dir ?? join(root, "backups");
  mkdirSync(dir, { recursive: true });
  const work = join(tmpdir(), `motard-backup-${randomUUID()}`);
  mkdirSync(work, { recursive: true });
  const tmpDb = join(work, "database.sqlite");
  try {
    // 1. online, consistent copy (SQLite backup API, stepwise: never blocks the event loop for long)
    try {
      await rt.conns.reader.backup(tmpDb);
    } catch (err) {
      const root2 = root;
      recordBackup({ path: join(dir, opts.fileName ?? `${opts.kind}-failed.zip`), kind: opts.kind, status: "FAILED", error: String(err) }, root2);
      throw new BackupV3Error("BACKUP_CREATE_FAILED", `online copy failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    return finishBackup(opts, root, dir, work, tmpDb);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/**
 * Same backup, synchronously, from an already-open connection — used at boot for the pre-migration
 * backup (T074/T095), before the runtime is registered. Step 1 is a VACUUM INTO snapshot.
 */
export function createAndVerifyBackupSync(conn: Database.Database, dbPath: string, opts: CreateBackupOptions): CreatedBackup {
  const root = rootOf(dbPath);
  const dir = opts.dir ?? join(root, "backups");
  mkdirSync(dir, { recursive: true });
  const work = join(tmpdir(), `motard-backup-${randomUUID()}`);
  mkdirSync(work, { recursive: true });
  const tmpDb = join(work, "database.sqlite");
  try {
    conn.exec(`VACUUM INTO '${tmpDb.replace(/'/g, "''")}'`);
    return finishBackup(opts, root, dir, work, tmpDb);
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

export interface OpenedBackup {
  manifest: BackupManifestV3;
  /** Extracted, verified database copy (caller owns and must delete `workDir`). */
  databasePath: string;
  workDir: string;
  entries: Record<string, Uint8Array>;
}

/**
 * T093: verify an archive completely — zip CRCs, manifest hash, every file hash, then the
 * extracted database (integrity, FKs, per-table rows + sha256). The source file is only read.
 */
export async function openAndVerifyBackupV3(file: string, opts: { keep?: boolean; maxJournalIdx?: number } = {}): Promise<OpenedBackup> {
  return openAndVerifyBackupV3Sync(file, opts);
}

export function openAndVerifyBackupV3Sync(file: string, opts: { keep?: boolean; maxJournalIdx?: number } = {}): OpenedBackup {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(readFileSync(file))); // validates every entry's CRC-32
  } catch (e) {
    throw new BackupV3Error("BACKUP_NOT_A_ZIP", `not a readable backup archive (${e instanceof Error ? e.message : String(e)})`);
  }
  const mBytes = entries["manifest.json"];
  if (!mBytes) {
    // v2 (PostgreSQL era) archives carry manifest.json too; anything without one is not ours.
    throw new BackupV3Error("BACKUP_MANIFEST_MISSING", "archive has no manifest.json");
  }
  const manifestText = strFromU8(mBytes);
  let manifest: BackupManifestV3;
  try {
    manifest = JSON.parse(manifestText) as BackupManifestV3;
  } catch {
    throw new BackupV3Error("BACKUP_MANIFEST_MISSING", "manifest.json is not valid JSON");
  }
  if (manifest.format !== BACKUP_FORMAT) throw new BackupV3Error("BACKUP_FORMAT_UNKNOWN", `unknown backup format "${String(manifest.format)}"`);
  const formatVersion = Number(manifest.formatVersion);
  if (formatVersion < 3 || "postgres" in (manifest as object)) {
    // Same archive family, PostgreSQL-era content (pg_dump-based v2): never imported into SQLite (DB-8, OQ-3).
    throw new BackupV3Error("BACKUP_POSTGRES_ERA", "this is a PostgreSQL-era backup (format v2) and cannot be restored by this version");
  }
  if (formatVersion > BACKUP_FORMAT_VERSION) throw new BackupV3Error("BACKUP_NEWER_THAN_APP", `backup format ${formatVersion} is newer than this app`);
  const declared = entries["manifest.sha256"] ? strFromU8(entries["manifest.sha256"]).trim() : null;
  if (!declared || declared !== sha256(manifestText)) {
    throw new BackupV3Error("BACKUP_MANIFEST_HASH_MISMATCH", "manifest.sha256 does not match manifest.json");
  }
  if (opts.maxJournalIdx !== undefined && manifest.schema.journalIdx > opts.maxJournalIdx) {
    throw new BackupV3Error("BACKUP_SCHEMA_NEWER_THAN_APP", `backup schema ${manifest.schema.journalIdx} is newer than this app (${opts.maxJournalIdx})`);
  }
  for (const f of manifest.files) {
    const data = entries[f.path];
    if (!data || data.byteLength !== f.bytes || sha256(data) !== f.sha256) {
      throw new BackupV3Error("BACKUP_FILE_HASH_MISMATCH", `file ${f.path} is missing or altered`);
    }
  }
  const dbBytes = entries["database.sqlite"];
  if (!dbBytes) throw new BackupV3Error("BACKUP_DATABASE_MISSING", "archive has no database.sqlite");
  const workDir = join(tmpdir(), `motard-verify-${randomUUID()}`);
  mkdirSync(workDir, { recursive: true });
  const databasePath = join(workDir, "database.sqlite");
  writeFileSync(databasePath, dbBytes);
  try {
    let db: Database.Database;
    try {
      db = new Database(databasePath, { readonly: true });
    } catch (e) {
      throw new BackupV3Error("BACKUP_INTEGRITY_FAILED", `database.sqlite cannot be opened (${e instanceof Error ? e.message : String(e)})`);
    }
    try {
      try {
        assertHealthy(db, "backup database");
      } catch (e) {
        if (e instanceof BackupV3Error) throw e;
        throw new BackupV3Error("BACKUP_INTEGRITY_FAILED", e instanceof Error ? e.message : String(e));
      }
      const actual = new Map(businessTables(db).map((t) => [t, tableDigest(db, t)]));
      for (const t of manifest.tables) {
        const a = actual.get(t.name);
        if (!a || a.rows !== t.rows || a.sha256 !== t.sha256) {
          throw new BackupV3Error("BACKUP_TABLE_MISMATCH", `table ${t.name}: manifest ${t.rows} rows ${t.sha256.slice(0, 12)}…, archive ${a?.rows ?? "missing"}`);
        }
      }
      if (actual.size !== manifest.tables.length) {
        throw new BackupV3Error("BACKUP_TABLE_MISMATCH", `archive has ${actual.size} tables, manifest lists ${manifest.tables.length}`);
      }
      for (const t of manifest.excludedTables) {
        const n = db.prepare(`SELECT count(*) FROM "${t}"`).pluck().get() as number;
        if (n !== 0) throw new BackupV3Error("BACKUP_TABLE_MISMATCH", `device-bound table ${t} is not empty in the archive`);
      }
    } finally {
      db.close();
    }
    if (!opts.keep) rmSync(workDir, { recursive: true, force: true });
    return { manifest, databasePath, workDir, entries };
  } catch (e) {
    rmSync(workDir, { recursive: true, force: true });
    throw e;
  }
}

