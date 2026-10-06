/**
 * Portable full backup / restore (format v2).
 *
 * WHY this exists: the old `/backup/full` wrote a JSON dump of a hard-coded
 * table list (it had silently fallen behind the schema: cashbox_daily_balances,
 * financial_operations, setup_wizard_state were missing), built the whole dump
 * in memory, read tables outside one snapshot, recorded no schema version, and
 * could only be restored with a developer CLI. This module replaces all of it.
 *
 * ── Archive layout (a real .zip) ─────────────────────────────────────────────
 *   manifest.json            format, app/schema/postgres versions, tenant, per-table rows + sha256
 *   manifest.sha256          sha256 of manifest.json bytes
 *   data/<table>.ndjson      one row per line, produced by PostgreSQL `row_to_json`
 *                            (exact numerics/timestamps — never re-encoded by JS)
 *   files/logos/*            company logo files (COMPANY_LOGO_DIR)
 *
 * ── What is (not) in a backup ────────────────────────────────────────────────
 * Every table that has a `tenant_id` column is backed up, discovered at run
 * time, so a table added by a future migration is included automatically.
 * Device/installation-bound tables are EXCLUDED on purpose (see
 * DEVICE_BOUND_TABLES): they describe the machine and its license activation,
 * not the company's data, and must be re-created on the machine that restores.
 *
 * ── Restore pipeline (nothing touches live data until step 6) ───────────────
 *   1. verify archive: zip CRC, manifest checksum, per-file sha256 + row counts
 *   2. schema compatibility: the backup's applied-migration hashes must be a
 *      PREFIX of this program's migrations (same lineage, older or equal);
 *      a backup from a NEWER program is refused
 *   3. staging database `erp_restore_*`, migrated to EXACTLY the backup's
 *      schema, data loaded, then re-read and compared byte-for-byte (sha256)
 *   4. remaining migrations applied to the staging copy (older backups get the
 *      same data migrations a live upgrade would have run)
 *   5. foreign-key orphan check on the staging copy
 *   6. ONE transaction on the live database: replace this company's rows with
 *      the staging rows, re-verify every table by sha256, re-check every
 *      foreign key, then COMMIT. Any failure / crash / power cut => ROLLBACK,
 *      the live database is exactly as before.
 *   7. staging database dropped
 */
import { createHash, randomUUID } from "node:crypto";
import { createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync, cpSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { openDedicatedClient, setTenantForTransaction } from "../orm/drizzle.js";
import { Zip, ZipDeflate, unzipSync, strToU8, strFromU8 } from "fflate";
import { drizzle } from "drizzle-orm/node-postgres";
import { migrate } from "drizzle-orm/node-postgres/migrator";
import { readMigrationFiles } from "drizzle-orm/migrator";

export const BACKUP_FORMAT = "motard-erp-backup";
export const BACKUP_FORMAT_VERSION = 2;

/** Machine / installation / license-activation state — never copied to another install. */
export const DEVICE_BOUND_TABLES = new Set([
  "licenses",
  "license_activations",
  "license_audit_events",
  "device_registrations",
  "secrets", // encrypted with this machine's APP_MASTER_KEY — unreadable elsewhere
  "server_installations",
  "revoked_tokens",
  "idempotency_keys", // per-device HTTP replay cache
  "invitation_codes", // device-local
]);

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FETCH_ROWS = 5000;
const INSERT_ROWS = 5000;

export type BackupTableEntry = {
  name: string;
  file: string;
  rows: number;
  sha256: string;
  columns: string[];
};

export type BackupManifest = {
  format: typeof BACKUP_FORMAT;
  formatVersion: number;
  createdAt: string;
  app: { version: string };
  postgres: { version: string };
  schema: { migrationsApplied: number; migrationHashes: string[]; lastMigrationHash: string | null };
  tenant: { id: string; name: string | null; ownerUserId: string | null; row: string };
  snapshot: "repeatable-read";
  tables: BackupTableEntry[];
  files: Array<{ path: string; bytes: number; sha256: string }>;
  excludedTables: string[];
};

export { BackupError } from "./backupError.js";
import { BackupError } from "./backupError.js";

const q = (ident: string) => `"${ident.replace(/"/g, '""')}"`;
/** Row text must not depend on the machine: pin the session formatting. */
const PIN_FORMAT = "SET TimeZone TO 'UTC'; SET DateStyle TO 'ISO, YMD'; SET IntervalStyle TO 'postgres'; SET extra_float_digits TO 1";
const sha = () => createHash("sha256");

type Queryable = { query: (text: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }> };

async function tenantTables(c: Queryable): Promise<string[]> {
  const { rows } = await c.query(
    `SELECT t.table_name AS name
       FROM information_schema.tables t
      WHERE t.table_schema = 'public' AND t.table_type = 'BASE TABLE'
        AND EXISTS (SELECT 1 FROM information_schema.columns c
                     WHERE c.table_schema = 'public' AND c.table_name = t.table_name AND c.column_name = 'tenant_id')
      ORDER BY 1`,
  );
  return rows.map((r) => r.name as string).filter((n) => !DEVICE_BOUND_TABLES.has(n));
}

async function tableColumns(c: Queryable, table: string): Promise<{ all: string[]; insertable: string[] }> {
  const { rows } = await c.query(
    `SELECT a.attname AS name, a.attgenerated AS gen
       FROM pg_attribute a
      WHERE a.attrelid = $1::regclass AND a.attnum > 0 AND NOT a.attisdropped
      ORDER BY a.attnum`,
    [`public.${q(table)}`],
  );
  return {
    all: rows.map((r) => r.name),
    insertable: rows.filter((r) => !r.gen).map((r) => r.name),
  };
}

/** Deterministic row order: primary key, else the whole row text. */
async function orderBy(c: Queryable, table: string): Promise<string> {
  const { rows } = await c.query(
    `SELECT a.attname AS name
       FROM pg_index i
       JOIN pg_attribute a ON a.attrelid = i.indrelid AND a.attnum = ANY(i.indkey)
      WHERE i.indrelid = $1::regclass AND i.indisprimary
      ORDER BY array_position(i.indkey, a.attnum)`,
    [`public.${q(table)}`],
  );
  return rows.length ? rows.map((r) => `t.${q(r.name)}`).join(", ") : "row_to_json(t)::text";
}

async function migrationState(c: Queryable): Promise<BackupManifest["schema"]> {
  const { rows } = await c.query(
    `SELECT hash FROM drizzle.__drizzle_migrations ORDER BY created_at, id`,
  );
  const hashes = rows.map((r) => r.hash as string);
  return { migrationsApplied: hashes.length, migrationHashes: hashes, lastMigrationHash: hashes.at(-1) ?? null };
}

/** Stream `row_to_json` lines of one table for one tenant through a server-side cursor. */
async function* streamRows(c: Queryable, table: string, tenantId: string, cursorName: string): AsyncGenerator<string[]> {
  if (!UUID_RE.test(tenantId)) throw new Error("invalid tenant id");
  const order = await orderBy(c, table);
  await c.query(
    `DECLARE ${cursorName} NO SCROLL CURSOR FOR
       SELECT row_to_json(t)::text AS j FROM public.${q(table)} t
        WHERE t.tenant_id = '${tenantId}' ORDER BY ${order}`,
  );
  try {
    for (;;) {
      const { rows } = await c.query(`FETCH ${FETCH_ROWS} FROM ${cursorName}`);
      if (!rows.length) break;
      yield rows.map((r) => r.j as string);
    }
  } finally {
    await c.query(`CLOSE ${cursorName}`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// BACKUP
// ─────────────────────────────────────────────────────────────────────────────

export async function createPortableBackup(opts: {
  /** A connection for the snapshot transaction: pooled (`release`) or dedicated (`end`). */
  connect: () => Promise<Queryable & { release?: () => void; end?: () => Promise<void> }>;
  tenantId: string;
  outFile: string;
  appVersion: string;
  logoDir?: string | null;
}): Promise<BackupManifest> {
  const client = await opts.connect();
  const release = () => (client.release ? client.release() : client.end?.());
  const out = createWriteStream(opts.outFile);
  const done = new Promise<void>((resolve, reject) => {
    out.on("finish", () => resolve());
    out.on("error", reject);
  });
  let zipError: Error | null = null;
  const zip = new Zip((err, chunk, final) => {
    if (err) {
      zipError = err;
      out.destroy(err);
      return;
    }
    out.write(chunk);
    if (final) out.end();
  });
  const addText = (name: string, text: string) => {
    const f = new ZipDeflate(name, { level: 6 });
    zip.add(f);
    f.push(strToU8(text), true);
  };

  try {
    await client.query(PIN_FORMAT);
    await client.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
    await setTenantForTransaction(client, opts.tenantId);
    const tenantRow = await client.query(
      `SELECT name, owner_user_id, row_to_json(t)::text AS j FROM tenants t WHERE id = $1`,
      [opts.tenantId],
    );
    if (!tenantRow.rows.length) throw new Error("tenant not found");
    const pgVersion = (await client.query("SHOW server_version")).rows[0].server_version as string;
    const schema = await migrationState(client);
    const tables: BackupTableEntry[] = [];
    let i = 0;
    for (const table of await tenantTables(client)) {
      const cols = await tableColumns(client, table);
      const file = `data/${table}.ndjson`;
      const entry = new ZipDeflate(file, { level: 6 });
      zip.add(entry);
      const h = sha();
      let rows = 0;
      for await (const batch of streamRows(client, table, opts.tenantId, `bk_${i++}`)) {
        const chunk = batch.join("\n") + "\n";
        h.update(chunk);
        entry.push(strToU8(chunk), false);
        rows += batch.length;
      }
      entry.push(new Uint8Array(0), true);
      tables.push({ name: table, file, rows, sha256: h.digest("hex"), columns: cols.all });
    }
    await client.query("COMMIT");

    const files: BackupManifest["files"] = [];
    if (opts.logoDir && existsSync(opts.logoDir)) {
      for (const name of readdirSync(opts.logoDir)) {
        const full = path.join(opts.logoDir, name);
        if (!statSync(full).isFile()) continue;
        const bytes = readFileSync(full);
        const rel = `files/logos/${name}`;
        const f = new ZipDeflate(rel, { level: 6 });
        zip.add(f);
        f.push(new Uint8Array(bytes), true);
        files.push({ path: rel, bytes: bytes.length, sha256: sha().update(bytes).digest("hex") });
      }
    }

    const manifest: BackupManifest = {
      format: BACKUP_FORMAT,
      formatVersion: BACKUP_FORMAT_VERSION,
      createdAt: new Date().toISOString(),
      app: { version: opts.appVersion },
      postgres: { version: pgVersion },
      schema,
      tenant: {
        id: opts.tenantId,
        name: tenantRow.rows[0].name ?? null,
        ownerUserId: tenantRow.rows[0].owner_user_id ?? null,
        // Parent row for the staging copy only; the live install keeps its own tenant row.
        row: tenantRow.rows[0].j,
      },
      snapshot: "repeatable-read",
      tables,
      files,
      excludedTables: [...DEVICE_BOUND_TABLES].sort(),
    };
    const manifestText = JSON.stringify(manifest, null, 2);
    addText("manifest.json", manifestText);
    addText("manifest.sha256", sha().update(manifestText).digest("hex"));
    zip.end();
    await done;
    if (zipError) throw zipError;
    return manifest;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    out.destroy();
    rmSync(opts.outFile, { force: true });
    throw err;
  } finally {
    release();
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// VERIFY
// ─────────────────────────────────────────────────────────────────────────────

export type OpenedBackup = { manifest: BackupManifest; entries: Record<string, Uint8Array> };

/** Full integrity check of an archive. Never touches any database. */
export async function openAndVerifyBackup(file: string): Promise<OpenedBackup> {
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(await readFile(file)));
  } catch (err) {
    throw new BackupError("BACKUP_CORRUPT", `ملف النسخة الاحتياطية تالف أو ليس ملف ZIP صالحاً (${(err as Error).message})`);
  }
  if (entries["database.json"] && !entries["manifest.json"]) {
    throw new BackupError(
      "BACKUP_UNSUPPORTED_FORMAT",
      "هذه نسخة بالصيغة القديمة (database.json) — لا تحتوي إصدار المخطط وتنقصها جداول (الأرصدة اليومية للصندوق والعمليات المالية)، لذا لا يمكن استعادتها دون فقدان بيانات. أنشئ نسخة جديدة من البرنامج الحالي.",
    );
  }
  const mBytes = entries["manifest.json"];
  const mSha = entries["manifest.sha256"];
  if (!mBytes || !mSha) throw new BackupError("BACKUP_CORRUPT", "النسخة ناقصة: ملف manifest.json مفقود");
  const mText = strFromU8(mBytes);
  if (sha().update(mText).digest("hex") !== strFromU8(mSha).trim()) {
    throw new BackupError("BACKUP_CORRUPT", "بصمة manifest.json غير مطابقة — الملف معدّل أو تالف");
  }
  let manifest: BackupManifest;
  try {
    manifest = JSON.parse(mText) as BackupManifest;
  } catch {
    throw new BackupError("BACKUP_CORRUPT", "manifest.json غير قابل للقراءة");
  }
  if (manifest.format !== BACKUP_FORMAT) throw new BackupError("BACKUP_UNSUPPORTED_FORMAT", "الملف ليس نسخة احتياطية من هذا البرنامج");
  if (manifest.formatVersion > BACKUP_FORMAT_VERSION) {
    throw new BackupError("BACKUP_NEWER_THAN_APP", `صيغة النسخة (${manifest.formatVersion}) أحدث من هذا البرنامج — حدّث البرنامج أولاً`);
  }
  if (!UUID_RE.test(manifest.tenant?.id ?? "")) throw new BackupError("BACKUP_CORRUPT", "معرّف الشركة في النسخة غير صالح");
  for (const t of manifest.tables) {
    const data = entries[t.file];
    if (!data) throw new BackupError("BACKUP_CORRUPT", `النسخة ناقصة: ${t.file} مفقود`);
    if (sha().update(data).digest("hex") !== t.sha256) {
      throw new BackupError("BACKUP_CORRUPT", `بصمة ${t.file} غير مطابقة — البيانات تالفة أو معدّلة`);
    }
    const lines = countLines(data);
    if (lines !== t.rows) throw new BackupError("BACKUP_CORRUPT", `${t.file}: عدد السجلات ${lines} لا يطابق ${t.rows}`);
  }
  for (const f of manifest.files ?? []) {
    const data = entries[f.path];
    if (!data || sha().update(data).digest("hex") !== f.sha256) {
      throw new BackupError("BACKUP_CORRUPT", `الملف المرفق ${f.path} مفقود أو تالف`);
    }
  }
  return { manifest, entries };
}

function countLines(data: Uint8Array): number {
  let n = 0;
  for (let i = 0; i < data.length; i++) if (data[i] === 10) n++;
  return n;
}

function* lineBatches(data: Uint8Array, size: number): Generator<string[]> {
  const text = strFromU8(data);
  let batch: string[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) === 10) {
      batch.push(text.slice(start, i));
      start = i + 1;
      if (batch.length >= size) {
        yield batch;
        batch = [];
      }
    }
  }
  if (batch.length) yield batch;
}

// ─────────────────────────────────────────────────────────────────────────────
// RESTORE
// ─────────────────────────────────────────────────────────────────────────────

export type RestoreReport = {
  ok: true;
  tenantId: string;
  sourceTenantId: string;
  backupCreatedAt: string;
  schema: { backup: number; app: number; migratedDuringRestore: number };
  tables: Array<{ name: string; rows: number; verified: "sha256" | "count" }>;
  safetyBackup: string | null;
  durationMs: number;
};

async function insertLines(c: Queryable, table: string, cols: string[], lines: string[]): Promise<void> {
  const list = cols.map(q).join(", ");
  await c.query(
    `INSERT INTO public.${q(table)} (${list}) OVERRIDING SYSTEM VALUE
     SELECT ${list} FROM json_populate_recordset(NULL::public.${q(table)}, $1::json)`,
    [`[${lines.join(",")}]`],
  );
}

async function tableHash(c: Queryable, table: string, tenantId: string, tag: string): Promise<{ rows: number; sha256: string }> {
  const h = sha();
  let rows = 0;
  for await (const batch of streamRows(c, table, tenantId, `vh_${tag}`)) {
    h.update(batch.join("\n") + "\n");
    rows += batch.length;
  }
  return { rows, sha256: h.digest("hex") };
}

async function fkOrphans(c: Queryable): Promise<string[]> {
  const { rows } = await c.query(
    `SELECT c.conname, c.conrelid::regclass::text AS child, c.confrelid::regclass::text AS parent,
            (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.conkey) WITH ORDINALITY k(n, ord)
               JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = k.n) AS ccols,
            (SELECT array_agg(a.attname::text ORDER BY k.ord) FROM unnest(c.confkey) WITH ORDINALITY k(n, ord)
               JOIN pg_attribute a ON a.attrelid = c.confrelid AND a.attnum = k.n) AS pcols
       FROM pg_constraint c
      WHERE c.contype = 'f' AND c.connamespace = 'public'::regnamespace`,
  );
  const bad: string[] = [];
  for (const fk of rows) {
    const cc: string[] = fk.ccols;
    const pc: string[] = fk.pcols;
    const notNull = cc.map((col) => `ch.${q(col)} IS NOT NULL`).join(" AND ");
    const join = cc.map((col, i) => `p.${q(pc[i]!)} = ch.${q(col)}`).join(" AND ");
    const r = await c.query(
      `SELECT count(*)::int AS n FROM ${fk.child} ch WHERE ${notNull}
         AND NOT EXISTS (SELECT 1 FROM ${fk.parent} p WHERE ${join})`,
    );
    if (r.rows[0].n > 0) bad.push(`${fk.child} → ${fk.parent} (${fk.conname}): ${r.rows[0].n}`);
  }
  return bad;
}

function withDatabase(url: string, db: string): string {
  const u = new URL(url);
  u.pathname = `/${db}`;
  return u.toString();
}

/** A copy of the migrations folder containing only the first `n` journal entries. */
function truncatedMigrations(folder: string, n: number): string {
  const dir = path.join(tmpdir(), `motard-mig-${randomUUID()}`);
  cpSync(folder, dir, { recursive: true });
  const jPath = path.join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(jPath, "utf8")) as { entries: unknown[] };
  journal.entries = journal.entries.slice(0, n);
  writeFileSync(jPath, JSON.stringify(journal, null, 2));
  return dir;
}

export async function restorePortableBackup(opts: {
  /** Live database, superuser connection (desktop runtime). */
  databaseUrl: string;
  migrationsFolder: string;
  file: string;
  targetTenantId: string;
  /** Required when the live company already has business data. */
  confirmReplace: boolean;
  logoDir?: string | null;
  /** Called before live data is replaced; returns the safety backup path. */
  safetyBackup?: () => Promise<string | null>;
  log?: (msg: string) => void;
}): Promise<RestoreReport> {
  const t0 = Date.now();
  const log = opts.log ?? (() => {});
  const { manifest, entries } = await openAndVerifyBackup(opts.file);
  log(`archive verified: ${manifest.tables.length} tables`);

  // ── 2. schema compatibility ───────────────────────────────────────────────
  const appFiles = readMigrationFiles({ migrationsFolder: opts.migrationsFolder });
  const appHashes = appFiles.map((f) => f.hash);
  const bHashes = manifest.schema.migrationHashes;
  if (bHashes.length > appHashes.length) {
    throw new BackupError(
      "BACKUP_NEWER_THAN_APP",
      `النسخة من إصدار أحدث من هذا البرنامج (مخطط ${bHashes.length} مقابل ${appHashes.length}). ثبّت الإصدار الأحدث ثم استعد.`,
    );
  }
  for (let i = 0; i < bHashes.length; i++) {
    if (bHashes[i] !== appHashes[i]) {
      throw new BackupError("BACKUP_SCHEMA_MISMATCH", `مخطط النسخة لا ينتمي لهذا البرنامج (اختلاف عند الترحيل رقم ${i + 1}).`);
    }
  }

  const live = await openDedicatedClient(opts.databaseUrl);
  await live.query(PIN_FORMAT);
  const stagingName = `erp_restore_${Date.now()}`;
  let stagingCreated = false;
  let migDir: string | null = null;
  try {
    // A restore killed mid-way (power cut, app closed) leaves its staging DB;
    // it never held live data, so it is simply discarded here.
    // Exactly our staging name shape (erp_restore_<epoch ms>), never the live DB.
    const stale = await live.query(
      `SELECT datname FROM pg_database WHERE datname ~ '^erp_restore_[0-9]{13}$' AND datname <> current_database()`,
    );
    for (const r of stale.rows) await live.query(`DROP DATABASE IF EXISTS ${q(r.datname)} WITH (FORCE)`);
    const liveTables = await tenantTables(live);
    const biz = await live.query(
      `SELECT (SELECT count(*) FROM invoices WHERE tenant_id = $1)
            + (SELECT count(*) FROM parties WHERE tenant_id = $1)
            + (SELECT count(*) FROM vouchers WHERE tenant_id = $1)
            + (SELECT count(*) FROM rolls WHERE tenant_id = $1) AS n`,
      [opts.targetTenantId],
    );
    const liveHasData = Number(biz.rows[0].n) > 0;
    if (liveHasData && !opts.confirmReplace) {
      throw new BackupError(
        "RESTORE_CONFIRM_REQUIRED",
        "هذا الجهاز يحتوي بيانات حالية. الاستعادة تستبدلها بالكامل (تؤخذ نسخة أمان تلقائية منها أولاً) — يلزم تأكيد صريح.",
      );
    }

    const src = manifest.tenant.id;
    const dst = opts.targetTenantId;
    const remap = (line: string) => (src === dst ? line : line.split(src).join(dst));
    const pendingMigrations = appHashes.length - bHashes.length;
    let safety: string | null = null;
    let report: RestoreReport["tables"] = [];

    /**
     * ONE transaction on the live database: replace this company's rows with
     * `source`, re-verify every table (rows + sha256 of the stored rows),
     * re-check every foreign key, advance sequences, then COMMIT. Any error,
     * crash or power cut before COMMIT => the live database is unchanged.
     */
    const swapIntoLive = async (
      tables: string[],
      source: (table: string, tag: string) => AsyncIterable<string[]>,
      expectSha: (table: string) => string | null,
      verified: "sha256" | "count",
    ) => {
      safety = liveHasData && opts.safetyBackup ? await opts.safetyBackup() : null;
      if (safety) log(`safety backup of current data: ${safety}`);
      const out: RestoreReport["tables"] = [];
      await live.query("BEGIN");
      try {
        await live.query("SET LOCAL session_replication_role = replica");
        await setTenantForTransaction(live, dst);
        for (const t of new Set([...liveTables, ...tables])) {
          await live.query(`DELETE FROM public.${q(t)} WHERE tenant_id = $1`, [dst]);
        }
        // Device-bound rows of THIS machine stay, but may point at users that
        // were just replaced.
        await live.query(`UPDATE device_registrations SET user_id = NULL WHERE tenant_id = $1`, [dst]);
        await live.query(`DELETE FROM invitation_codes WHERE tenant_id = $1`, [dst]);
        let k = 0;
        for (const t of tables) {
          if (!liveTables.includes(t)) throw new BackupError("RESTORE_FAILED", `الجدول ${t} غير موجود في هذا البرنامج`);
          const cols = await tableColumns(live, t);
          const h = sha();
          let rows = 0;
          for await (const batch of source(t, `cp_${k}`)) {
            const mapped = batch.map(remap);
            h.update(mapped.join("\n") + "\n");
            for (let i = 0; i < mapped.length; i += INSERT_ROWS) {
              await insertLines(live, t, cols.insertable, mapped.slice(i, i + INSERT_ROWS));
            }
            rows += batch.length;
          }
          const expected = expectSha(t) ?? h.digest("hex");
          const got = await tableHash(live, t, dst, `lv${k++}`);
          if (got.rows !== rows || got.sha256 !== expected) {
            throw new BackupError("RESTORE_VERIFY_FAILED", `التحقق النهائي فشل في ${t}: ${got.rows}/${rows} سجل`);
          }
          out.push({ name: t, rows, verified });
        }
        // sync_devices restored from another machine keep their identity but
        // not a link to this machine's license registration.
        await live.query(`UPDATE sync_devices SET device_registration_id = NULL WHERE tenant_id = $1
                            AND device_registration_id IS NOT NULL
                            AND NOT EXISTS (SELECT 1 FROM device_registrations d WHERE d.id = sync_devices.device_registration_id)`, [dst]);
        await live.query(
          `UPDATE tenants SET owner_user_id = (SELECT id FROM users WHERE id = $2 AND tenant_id = $1),
                              name = COALESCE($3, name)
            WHERE id = $1`,
          [dst, manifest.tenant.ownerUserId, manifest.tenant.name],
        );
        const liveOrphans = await fkOrphans(live);
        if (liveOrphans.length) throw new BackupError("RESTORE_VERIFY_FAILED", `علاقات مكسورة بعد الاستعادة: ${liveOrphans.join("; ")}`);
        // serial/identity sequences: never lower a shared sequence
        const seqs = await live.query(
          `SELECT s.relname AS seq, t.relname AS tbl, a.attname AS col
             FROM pg_class s
             JOIN pg_depend d ON d.objid = s.oid AND d.deptype IN ('a', 'i')
             JOIN pg_class t ON t.oid = d.refobjid
             JOIN pg_attribute a ON a.attrelid = t.oid AND a.attnum = d.refobjsubid
            WHERE s.relkind = 'S' AND t.relnamespace = 'public'::regnamespace`,
        );
        for (const sq of seqs.rows) {
          await live.query(
            `SELECT setval('public.${q(sq.seq)}', GREATEST((SELECT last_value FROM public.${q(sq.seq)}),
                    COALESCE((SELECT max(${q(sq.col)}) FROM public.${q(sq.tbl)}), 1)))`,
          );
        }
        await live.query("COMMIT");
      } catch (err) {
        await live.query("ROLLBACK").catch(() => {});
        throw err;
      }
      report = out;
    };

    const sameSchema =
      pendingMigrations === 0 &&
      (await (async () => {
        for (const t of manifest.tables) {
          const cols = await tableColumns(live, t.name).catch(() => null);
          if (!cols || cols.all.join() !== t.columns.join()) return false;
        }
        return true;
      })());

    if (sameSchema) {
      // ── 3a. same schema: load the verified archive straight into the live
      // transaction — no staging copy (halves the work on large companies).
      const byName = new Map(manifest.tables.map((t) => [t.name, t]));
      await swapIntoLive(
        manifest.tables.map((t) => t.name),
        async function* (table) {
          yield* lineBatches(entries[byName.get(table)!.file]!, FETCH_ROWS);
        },
        (table) => (src === dst ? byName.get(table)!.sha256 : null),
        "sha256",
      );
      log("live database replaced and verified (same schema, direct)");
    } else {
      // ── 3b. older backup: staging at the backup's exact schema ─────────────
      await live.query(`CREATE DATABASE ${q(stagingName)}`);
      stagingCreated = true;
      const staging = await openDedicatedClient(withDatabase(opts.databaseUrl, stagingName));
      await staging.query(PIN_FORMAT);
      try {
        migDir = truncatedMigrations(opts.migrationsFolder, bHashes.length);
        await migrate(drizzle(staging), { migrationsFolder: migDir });
        const sState = await migrationState(staging);
        if (sState.migrationHashes.join() !== bHashes.join()) {
          throw new BackupError("RESTORE_FAILED", "تعذّر بناء قاعدة مؤقتة بنفس مخطط النسخة");
        }
        log(`staging ${stagingName} at backup schema (${bHashes.length} migrations)`);

        await staging.query("BEGIN");
        await staging.query("SET LOCAL session_replication_role = replica");
        // Parent tenant row (device links cleared; owner re-linked after users load).
        const tCols = await tableColumns(staging, "tenants");
        await insertLines(staging, "tenants", tCols.insertable, [manifest.tenant.row]);
        await staging.query(`UPDATE tenants SET activation_id = NULL, owner_user_id = NULL WHERE id = $1`, [src]);
        for (const t of manifest.tables) {
          const cols = await tableColumns(staging, t.name).catch(() => null);
          if (!cols) throw new BackupError("RESTORE_FAILED", `الجدول ${t.name} غير موجود في مخطط النسخة`);
          if (cols.all.join() !== t.columns.join()) {
            throw new BackupError("RESTORE_FAILED", `أعمدة ${t.name} لا تطابق مخطط النسخة`);
          }
          for (const batch of lineBatches(entries[t.file]!, INSERT_ROWS)) await insertLines(staging, t.name, cols.insertable, batch);
        }
        await staging.query(
          `UPDATE tenants SET owner_user_id = (SELECT id FROM users WHERE id = $2) WHERE id = $1`,
          [src, manifest.tenant.ownerUserId],
        );
        await staging.query("COMMIT");
        // byte-exact re-read of what was loaded
        let k = 0;
        await staging.query("BEGIN READ ONLY");
        for (const t of manifest.tables) {
          const got = await tableHash(staging, t.name, src, `s${k++}`);
          if (got.rows !== t.rows || got.sha256 !== t.sha256) {
            await staging.query("ROLLBACK");
            throw new BackupError("RESTORE_VERIFY_FAILED", `التحقق فشل في ${t.name}: ${got.rows}/${t.rows} سجل`);
          }
        }
        await staging.query("COMMIT");
        log("staging data verified byte-for-byte against the backup");

        // ── 4. bring the staging copy to this program's schema ─────────────
        if (pendingMigrations > 0) {
          await migrate(drizzle(staging), { migrationsFolder: opts.migrationsFolder });
          log(`applied ${pendingMigrations} newer migrations to the restored data`);
        }
        // ── 5. referential integrity of the restored company ───────────────
        const orphans = await fkOrphans(staging);
        if (orphans.length) throw new BackupError("RESTORE_VERIFY_FAILED", `علاقات مكسورة في النسخة: ${orphans.join("; ")}`);

        // ── 6. one atomic swap into the live database ───────────────────────
        const stagingTables = await tenantTables(staging);
        await staging.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        try {
          await swapIntoLive(stagingTables, (table, tag) => streamRows(staging, table, src, tag), () => null, "count");
          await staging.query("COMMIT");
        } catch (err) {
          await staging.query("ROLLBACK").catch(() => {});
          throw err;
        }
        log("live database replaced and verified (via staging + migrations)");
      } finally {
        await staging.end().catch(() => {});
      }
    }

    if (opts.logoDir) {
      for (const f of manifest.files ?? []) {
        if (!f.path.startsWith("files/logos/")) continue;
        mkdirSync(opts.logoDir, { recursive: true });
        writeFileSync(path.join(opts.logoDir, path.basename(f.path)), entries[f.path]!);
      }
    }
    return {
      ok: true,
      tenantId: dst,
      sourceTenantId: src,
      backupCreatedAt: manifest.createdAt,
      schema: { backup: bHashes.length, app: appHashes.length, migratedDuringRestore: pendingMigrations },
      tables: report,
      safetyBackup: safety,
      durationMs: Date.now() - t0,
    };
  } catch (err) {
    if (err instanceof BackupError) throw err;
    throw new BackupError("RESTORE_FAILED", `فشلت الاستعادة ولم تتغير البيانات الحالية: ${(err as Error).message}`);
  } finally {
    if (stagingCreated) await live.query(`DROP DATABASE IF EXISTS ${q(stagingName)} WITH (FORCE)`).catch(() => {});
    await live.end().catch(() => {});
    if (migDir) rmSync(migDir, { recursive: true, force: true });
  }
}
