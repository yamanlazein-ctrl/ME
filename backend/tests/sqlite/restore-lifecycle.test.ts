/**
 * Restore is a whole-application transition, not only a file swap (audit DESK-024…027, 031).
 * A real SQLite runtime is backed up, changed, then restored IN THE SAME PROCESS, and everything that
 * was bound to the previous database is checked against the restored one:
 *   - repositories built before the restore keep working (no closed connection);
 *   - a transaction waiting on the write gate across the swap runs on the new connection;
 *   - cached idempotent responses of the previous database are not carried into the restored one;
 *   - the identity cache forgets users of the previous database;
 *   - the integrity baseline is the restored counts (no SAFE_MODE on the next start);
 *   - a running sync cycle finishes before the swap, and none starts during it.
 * Own temporary data root; DESKTOP_DEPLOY (the manifest is desktop-only), restored afterwards.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

const root = mkdtempSync(join(tmpdir(), "motard-restore-life-"));
const saved = { ...process.env };
process.env.DB_ENGINE = "sqlite";
process.env.DESKTOP_DEPLOY = "true";
process.env.SQLITE_PATH = join(root, "data", "motard.db");
process.env.MOTARD_STARTUP_STATE = "FRESH";
process.env.MOTARD_INSTALLATION_ID = randomUUID();
process.env.DATA_INTEGRITY_PATH = join(root, "state", "data-integrity.json");
delete process.env.DATABASE_URL;
delete process.env.DESKTOP_SEED_PATH;
delete process.env.DESKTOP_SQLITE_MIGRATIONS_FOLDER;
delete process.env.DESKTOP_DB_META_PATH;

const tenantId = randomUUID();
const userId = randomUUID();
let archive = "";

let runtime: typeof import("@/infrastructure/orm/sqlite/runtime.js");
let restore: typeof import("@/infrastructure/backup/sqliteRestore.js");
let tx: typeof import("@/infrastructure/orm/sqlite/transaction.js");
let gate: typeof import("@/infrastructure/sync/syncRunGate.js");

const writer = () => runtime.getSqliteRuntime()!.conns.writer;
const count = (table: string) =>
  (writer().prepare(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;

beforeAll(async () => {
  runtime = await import("@/infrastructure/orm/sqlite/runtime.js");
  restore = await import("@/infrastructure/backup/sqliteRestore.js");
  tx = await import("@/infrastructure/orm/sqlite/transaction.js");
  gate = await import("@/infrastructure/sync/syncRunGate.js");
  await runtime.ensureSqliteRuntime();
  await tx.runInTransaction(async (t) => {
    await t.execute(
      sql`INSERT INTO tenants (id, name, slug) VALUES (${tenantId}, ${"Life Co"}, ${"default"})`,
    );
  });
  const { createAndVerifyBackup } = await import("@/infrastructure/backup/sqliteBackup.js");
  archive = (await createAndVerifyBackup({ kind: "manual", appVersion: "test" })).path;
});

afterAll(async () => {
  const rt = runtime.getSqliteRuntime();
  if (rt) (await import("@/infrastructure/orm/sqlite/connection.js")).closeSqlite(rt.conns);
  process.env = saved;
  rmSync(root, { recursive: true, force: true });
});

describe("restore inside a running backend", () => {
  it("rebinds every consumer of the previous database to the restored one", async () => {
    // State that exists only AFTER the backup.
    await tx.runInTransaction(async (t) => {
      await t.execute(sql`INSERT INTO users (id, tenant_id, name, email, password_hash, role)
        VALUES (${userId}, ${tenantId}, ${"Later Admin"}, ${"later@x.io"}, ${"h"}, ${"admin"})`);
      await t.execute(sql`INSERT INTO idempotency_keys (tenant_id, method, path, idempotency_key, status_code, expires_at)
        VALUES (${tenantId}, ${"POST"}, ${"/api/invoices"}, ${"K"}, ${201}, ${"2999-01-01T00:00:00.000000Z"})`);
    });
    const { resolveSessionIdentity } = await import("@/infrastructure/auth/sessionCutoff.js");
    expect((await resolveSessionIdentity(userId, userId)).known).toBe(true); // now cached
    const integrity = await import("@/infrastructure/integrity/dataIntegrityManifest.js");
    const { sqliteReaderQueryable } = await import("@/infrastructure/orm/sqlite/queryable.js");
    await integrity.verifyDataAgainstManifest(sqliteReaderQueryable(), tenantId, "sqlite");
    const m0 = (await integrity.readManifest())!;
    // Pretend the live company had grown a lot since the backup (a restore must not read as a drop).
    await integrity.writeManifestAtomic({
      ...m0,
      lastKnownCounts: { ...m0.lastKnownCounts, parties: 100, invoices: 100 },
    });

    const independent = tx.sqliteIndependentDb(); // what repositories hold for the whole process
    await restore.restoreBackupV3(archive, { skipSafetyBackup: true });

    // DESK-024: the handle built before the restore reaches the restored (open) database.
    const r = (await independent.execute(sql`SELECT count(*) AS n FROM users`)) as unknown;
    const rows = (Array.isArray(r) ? r : (r as { rows: unknown[] }).rows) as Array<{ n: number }>;
    expect(Number(rows[0].n)).toBe(0);
    // DESK-025: no cached "201 created" from the previous database.
    expect(count("idempotency_keys")).toBe(0);
    // DESK-026: the user created after the backup is unknown now, not served from the cache.
    expect((await resolveSessionIdentity(userId, userId)).known).toBe(false);
    // DESK-027: the restored counts are the baseline; the next start's check passes.
    const m1 = (await integrity.readManifest())!;
    expect(m1.lastBootDecision).toBe("RESTORE");
    expect(m1.lastKnownCounts.parties).toBe(0);
    await integrity.verifyDataAgainstManifest(sqliteReaderQueryable(), tenantId, "sqlite");
    expect(integrity.isDataSafeMode()).toBe(false);
  });

  it("a transaction waiting on the write gate across a reopen runs on the new connection", async () => {
    let waiting: Promise<unknown> | null = null;
    await tx.withWriteGateHeld(async () => {
      waiting = tx.runInTransaction((t) => t.execute(sql`SELECT 1 AS one`));
      await new Promise((r) => setTimeout(r, 20)); // it is queued behind the held gate
      runtime.reopenSqliteRuntime();
    });
    await expect(waiting).resolves.toBeDefined();
  });

  it("waits for a running sync cycle and lets none start during the swap", async () => {
    expect(gate.tryAcquireSyncRun(`${tenantId}:sync-run`)).toBe(true); // a cycle is running
    let done = false;
    const restoring = restore.restoreBackupV3(archive, { skipSafetyBackup: true }).then(() => {
      done = true;
    });
    await new Promise((r) => setTimeout(r, 300));
    expect(done).toBe(false);
    expect(gate.isSyncPaused()).toBe(true);
    expect(gate.tryAcquireSyncRun("other:sync-run")).toBe(false); // no new cycle meanwhile
    gate.releaseSyncRun(`${tenantId}:sync-run`);
    await restoring;
    expect(done).toBe(true);
    expect(gate.isSyncPaused()).toBe(false);
    expect(gate.tryAcquireSyncRun(`${tenantId}:sync-run`)).toBe(true);
    gate.releaseSyncRun(`${tenantId}:sync-run`);
  });
});
