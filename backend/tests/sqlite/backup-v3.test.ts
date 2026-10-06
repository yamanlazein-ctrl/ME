/**
 * T090 (specs/001-desktop-sqlite-engine, contracts/backup-format-v3.md): backup format v3 —
 * creation, verification, rejection codes, licence/device-bound state, and the restore guarantees
 * for the device state (same device keeps it; a fresh device gets none).
 *
 * Runs on its own temporary data root (restore swaps the live file), on either suite.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";
import { unzipSync, zipSync, strFromU8, strToU8 } from "fflate";

const root = mkdtempSync(join(tmpdir(), "motard-bk3-"));
const freshRoot = mkdtempSync(join(tmpdir(), "motard-bk3-fresh-"));
process.env.DB_ENGINE = "sqlite";
process.env.SQLITE_PATH = join(root, "data", "motard.db");
process.env.MOTARD_STARTUP_STATE = "FRESH";
delete process.env.DATABASE_URL;
delete process.env.DESKTOP_SEED_PATH;

const TENANT = randomUUID();
const LICENSE = randomUUID();
const ACTIVATION = randomUUID();
const sha = (b: Uint8Array | string) => createHash("sha256").update(b).digest("hex");

type Mods = {
  runtime: typeof import("@/infrastructure/orm/sqlite/runtime.js");
  backup: typeof import("@/infrastructure/backup/sqliteBackup.js");
  restore: typeof import("@/infrastructure/backup/sqliteRestore.js");
  config: { SQLITE_PATH?: string; MOTARD_STARTUP_STATE?: string };
};
let m: Mods;
let created: Awaited<ReturnType<Mods["backup"]["createAndVerifyBackup"]>>;

function writer(): Database.Database {
  return m.runtime.getSqliteRuntime()!.conns.writer as unknown as Database.Database;
}

/** A company with a bound licence, an activation, a device, secrets and audit rows. */
function seedCompany(db: Database.Database): void {
  db.prepare(`INSERT INTO tenants (id, name, slug) VALUES (?, 'شركة النسخ', 'bk3')`).run(TENANT);
  db.prepare(
    `INSERT INTO licenses (id, key, type, status, plan, edition, tenant_id, customer_name, max_devices, limits,
                           binding_type, binding_value, offline_token, offline_token_jti)
     VALUES (?, 'LIC-BK3-0001', 'full', 'active', 'standard', 'enterprise', ?, 'Backup Co', 3, '{"users":5}',
             'fingerprint', 'fp-device-a', 'signed.offline.token', 'jti-0001')`,
  ).run(LICENSE, TENANT);
  db.prepare(`INSERT INTO license_activations (id, license_id, tenant_id, server_fingerprint) VALUES (?, ?, ?, 'fp-device-a')`).run(ACTIVATION, LICENSE, TENANT);
  db.prepare(`UPDATE tenants SET activation_id = ? WHERE id = ?`).run(ACTIVATION, TENANT);
  db.prepare(
    `INSERT INTO device_registrations (id, license_id, tenant_id, device_id, device_fingerprint, platform) VALUES (?, ?, ?, ?, 'fp-device-a', 'windows')`,
  ).run(randomUUID(), LICENSE, TENANT, randomUUID());
  db.prepare(`INSERT INTO secrets (id, tenant_id, key, ciphertext, iv) VALUES (?, ?, 'license.token.current', 'c1', 'i1')`).run(randomUUID(), TENANT);
  db.prepare(`INSERT INTO license_audit_events (event_type, tenant_id, license_id) VALUES ('activated', ?, ?)`).run(TENANT, LICENSE);
  const party = randomUUID();
  db.prepare(`INSERT INTO parties (id, tenant_id, kind, name) VALUES (?, ?, 'customer', 'زبون أ')`).run(party, TENANT);
}

/** Rewrite one archive member (and optionally keep manifest.sha256 consistent). */
function rewriteArchive(src: string, dst: string, edit: (e: Record<string, Uint8Array>) => void): string {
  const entries = unzipSync(new Uint8Array(readFileSync(src)));
  edit(entries);
  writeFileSync(dst, zipSync(entries));
  return dst;
}
const code = (fn: () => unknown): string => {
  try {
    fn();
    return "NO_ERROR";
  } catch (e) {
    return (e as { code?: string }).code ?? String(e);
  }
};

beforeAll(async () => {
  m = {
    runtime: await import("@/infrastructure/orm/sqlite/runtime.js"),
    backup: await import("@/infrastructure/backup/sqliteBackup.js"),
    restore: await import("@/infrastructure/backup/sqliteRestore.js"),
    config: (await import("@/infrastructure/config/env.js")).config as never,
  };
  await m.runtime.ensureSqliteRuntime();
  seedCompany(writer());
  created = await m.backup.createAndVerifyBackup({ kind: "manual", appVersion: "test" });
});

afterAll(() => {
  m?.runtime.shutdownSqliteRuntime();
  rmSync(root, { recursive: true, force: true });
  rmSync(freshRoot, { recursive: true, force: true });
});

describe("backup v3 — creation", () => {
  it("creates a VERIFIED archive and records it in the registry", async () => {
    expect(existsSync(created.path)).toBe(true);
    expect(existsSync(`${created.path}.partial`)).toBe(false);
    expect(created.manifest.formatVersion).toBe(3);
    const { readRegistry } = await import("@/infrastructure/backup/backupRegistry.js");
    const entry = readRegistry(root).entries.find((e: { path: string }) => e.path === created.path);
    expect(entry?.status).toBe("VERIFIED");
  });

  it("re-verifies cleanly: zip CRC, manifest hash, per-table rows + sha256, integrity, FKs", () => {
    const opened = m.backup.openAndVerifyBackupV3Sync(created.path, { keep: true });
    try {
      const db = new Database(opened.databasePath, { readonly: true });
      expect(db.pragma("foreign_key_check")).toEqual([]);
      // excluded tables: present in the schema, empty in the copy
      for (const t of m.backup.EXCLUDED_TABLES) {
        expect(db.prepare(`SELECT count(*) FROM "${t}"`).pluck().get(), t).toBe(0);
      }
      // the licence row is KEPT with its company identity; only device-bound columns are NULL
      const lic = db.prepare(`SELECT * FROM licenses WHERE id = ?`).get(LICENSE) as Record<string, unknown>;
      expect(lic).toBeTruthy();
      expect(lic).toMatchObject({ key: "LIC-BK3-0001", type: "full", status: "active", plan: "standard", edition: "enterprise", tenant_id: TENANT, customer_name: "Backup Co" });
      expect(JSON.parse(String(lic.limits))).toEqual({ users: 5 });
      for (const c of ["binding_type", "binding_value", "offline_token", "offline_token_jti"]) expect(lic[c], c).toBeNull();
      expect(db.prepare(`SELECT activation_id FROM tenants WHERE id = ?`).pluck().get(TENANT)).toBeNull();
      db.close();
      expect(opened.manifest.excludedTables).toEqual([...m.backup.EXCLUDED_TABLES]);
    } finally {
      rmSync(opened.workDir, { recursive: true, force: true });
    }
  });
});

describe("backup v3 — rejection codes", () => {
  it("rejects a flipped byte in every archive member (CRC)", () => {
    const entries = unzipSync(new Uint8Array(readFileSync(created.path)));
    for (const name of Object.keys(entries)) {
      const raw = new Uint8Array(readFileSync(created.path));
      // locate the member's compressed data via its local header name and flip a byte after it
      const at = Buffer.from(raw).indexOf(Buffer.from(name));
      expect(at, name).toBeGreaterThan(0);
      const bad = Uint8Array.from(raw);
      bad[at + name.length + 8] ^= 0xff;
      const f = join(root, `flip-${name.replace(/[^\w]/g, "_")}.zip`);
      writeFileSync(f, bad);
      expect(code(() => m.backup.openAndVerifyBackupV3Sync(f)), name).toMatch(/^BACKUP_(NOT_A_ZIP|MANIFEST_HASH_MISMATCH|FILE_HASH_MISMATCH|INTEGRITY_FAILED|TABLE_MISMATCH|MANIFEST_MISSING)$/);
    }
  });

  it("rejects a truncated archive", () => {
    const raw = readFileSync(created.path);
    const f = join(root, "truncated.zip");
    writeFileSync(f, raw.subarray(0, Math.floor(raw.length / 2)));
    expect(code(() => m.backup.openAndVerifyBackupV3Sync(f))).toBe("BACKUP_NOT_A_ZIP");
  });

  it("rejects a manifest whose hash does not match manifest.sha256", () => {
    const f = rewriteArchive(created.path, join(root, "manifest-edit.zip"), (e) => {
      const man = JSON.parse(strFromU8(e["manifest.json"]));
      man.tenant.name = "tampered";
      e["manifest.json"] = strToU8(JSON.stringify(man));
    });
    expect(code(() => m.backup.openAndVerifyBackupV3Sync(f))).toBe("BACKUP_MANIFEST_HASH_MISMATCH");
  });

  it("rejects an archive without database.sqlite", () => {
    const f = rewriteArchive(created.path, join(root, "no-db.zip"), (e) => {
      delete e["database.sqlite"];
    });
    expect(code(() => m.backup.openAndVerifyBackupV3Sync(f))).toBe("BACKUP_DATABASE_MISSING");
  });

  it("rejects a PostgreSQL-era (formatVersion 2) backup", () => {
    const f = rewriteArchive(created.path, join(root, "v2.zip"), (e) => {
      const man = JSON.parse(strFromU8(e["manifest.json"]));
      man.formatVersion = 2;
      e["manifest.json"] = strToU8(JSON.stringify(man));
      e["manifest.sha256"] = strToU8(sha(e["manifest.json"]));
    });
    expect(code(() => m.backup.openAndVerifyBackupV3Sync(f))).toBe("BACKUP_POSTGRES_ERA");
  });

  it("rejects a backup from a newer format (formatVersion > 3)", () => {
    const f = rewriteArchive(created.path, join(root, "v4.zip"), (e) => {
      const man = JSON.parse(strFromU8(e["manifest.json"]));
      man.formatVersion = 4;
      e["manifest.json"] = strToU8(JSON.stringify(man));
      e["manifest.sha256"] = strToU8(sha(e["manifest.json"]));
    });
    expect(code(() => m.backup.openAndVerifyBackupV3Sync(f))).toBe("BACKUP_NEWER_THAN_APP");
  });
});

describe("backup v3 — restore and device-bound state", () => {
  it("same-device restore keeps the live activation, device, secrets, binding, offline token and audit rows; the archive is unchanged", async () => {
    const before = sha(readFileSync(created.path));
    // business change after the backup: restore must bring the backup's data back
    writer().prepare(`INSERT INTO parties (id, tenant_id, kind, name) VALUES (?, ?, 'supplier', 'بعد النسخة')`).run(randomUUID(), TENANT);
    const report = await m.restore.restoreBackupV3(created.path);
    expect(report.carriedOver.license_activations).toBe(1);
    const db = writer();
    expect(db.prepare(`SELECT count(*) FROM parties WHERE tenant_id = ?`).pluck().get(TENANT)).toBe(1);
    expect(db.prepare(`SELECT activation_id FROM tenants WHERE id = ?`).pluck().get(TENANT)).toBe(ACTIVATION);
    const lic = db.prepare(`SELECT binding_type, binding_value, offline_token, offline_token_jti FROM licenses WHERE id = ?`).get(LICENSE);
    expect(lic).toEqual({ binding_type: "fingerprint", binding_value: "fp-device-a", offline_token: "signed.offline.token", offline_token_jti: "jti-0001" });
    for (const t of ["license_activations", "device_registrations", "secrets", "license_audit_events"]) {
      expect(db.prepare(`SELECT count(*) FROM "${t}"`).pluck().get(), t).toBe(1);
    }
    expect(db.prepare(`SELECT restored_from FROM motard_meta WHERE id = 1`).pluck().get()).toBeTruthy();
    expect(sha(readFileSync(created.path))).toBe(before);
  });

  it("restore onto a fresh device brings the company but no activation (licence verification required)", async () => {
    // a second, fresh installation on another data root
    m.runtime.shutdownSqliteRuntime();
    m.config.SQLITE_PATH = join(freshRoot, "data", "motard.db");
    m.config.MOTARD_STARTUP_STATE = "FRESH";
    await m.runtime.ensureSqliteRuntime();
    await m.restore.restoreBackupV3(created.path);
    const db = writer();
    expect(db.prepare(`SELECT name FROM tenants WHERE id = ?`).pluck().get(TENANT)).toBe("شركة النسخ");
    expect(db.prepare(`SELECT activation_id FROM tenants WHERE id = ?`).pluck().get(TENANT)).toBeNull();
    expect(db.prepare(`SELECT count(*) FROM license_activations`).pluck().get()).toBe(0);
    const lic = db.prepare(`SELECT key, binding_type, offline_token FROM licenses WHERE id = ?`).get(LICENSE);
    expect(lic).toEqual({ key: "LIC-BK3-0001", binding_type: null, offline_token: null });
  });
});
