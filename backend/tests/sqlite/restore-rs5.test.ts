/**
 * T091 (specs/001-desktop-sqlite-engine, data-model.md §5.3): restore = staged, verified, atomic.
 *   - a company built through the real SQLite repositories is backed up, changed, then restored:
 *     the RS-5 figures (record counts, parties, invoices, vouchers, returns, balances, ledger,
 *     inventory, cash box) equal the archive's exactly;
 *   - a forced failure at EVERY restore step leaves the live database byte-identical;
 *   - an archive one migration behind the app is migrated on staging (never on the live file).
 * Own temporary data root; runs on either suite.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, cpSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash, randomUUID } from "node:crypto";
import Database from "better-sqlite3";

const root = mkdtempSync(join(tmpdir(), "motard-rs5-"));
process.env.DB_ENGINE = "sqlite";
process.env.SQLITE_PATH = join(root, "data", "motard.db");
process.env.MOTARD_STARTUP_STATE = "FRESH";
delete process.env.DATABASE_URL;
delete process.env.DESKTOP_SEED_PATH;
delete process.env.DESKTOP_SQLITE_MIGRATIONS_FOLDER;

const tenantId = randomUUID();
const customerId = randomUUID();
const supplierId = randomUUID();
const fabricId = randomUUID();
const colorId = randomUUID();
const ctx = { tenantId, userId: randomUUID(), userRole: "admin" as const, userName: "rs5" };
const sha = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

let runtime: typeof import("@/infrastructure/orm/sqlite/runtime.js");
let backup: typeof import("@/infrastructure/backup/sqliteBackup.js");
let restore: typeof import("@/infrastructure/backup/sqliteRestore.js");
let rs5: typeof import("@/infrastructure/backup/rs5.js");
let archive: string;
let archiveFigures: Record<string, string>;

const livePath = () => runtime.getSqliteRuntime()!.conns.path;
/** Byte image of the live database, checkpointed so the WAL holds nothing pending. */
function liveImage(): string {
  const w = runtime.getSqliteRuntime()!.conns.writer as unknown as Database.Database;
  w.pragma("wal_checkpoint(TRUNCATE)");
  return sha(new Uint8Array(readFileSync(livePath())));
}

beforeAll(async () => {
  runtime = await import("@/infrastructure/orm/sqlite/runtime.js");
  backup = await import("@/infrastructure/backup/sqliteBackup.js");
  restore = await import("@/infrastructure/backup/sqliteRestore.js");
  rs5 = await import("@/infrastructure/backup/rs5.js");
  await runtime.ensureSqliteRuntime();

  const { db, runInTransaction } = await import("@/infrastructure/orm/sqlite/drizzleCompat.js");
  const { runWithTenantContext } = await import("@/infrastructure/orm/tenant-context.js");
  const s = {
    tenants: (await import("@/infrastructure/orm/sqlite/schemas/tenant.table.js")).tenants,
    parties: (await import("@/infrastructure/orm/sqlite/schemas/party.table.js")).parties,
    fabrics: (await import("@/infrastructure/orm/sqlite/schemas/fabric.table.js")).fabrics,
    colors: (await import("@/infrastructure/orm/sqlite/schemas/color.table.js")).colors,
  };
  const { SqliteRollRepository } = await import("@/infrastructure/repositories/sqlite/SqliteRollRepository.js");
  const { SqliteInvoiceRepository } = await import("@/infrastructure/repositories/sqlite/SqliteInvoiceRepository.js");
  const { SqliteReturnRepository } = await import("@/infrastructure/repositories/sqlite/SqliteReturnRepository.js");
  const { SqliteVoucherRepository } = await import("@/infrastructure/repositories/sqlite/SqliteVoucherRepository.js");
  const { SqliteCashboxRepository } = await import("@/infrastructure/repositories/sqlite/SqliteCashboxRepository.js");

  await runInTransaction(async (tx) => {
    await tx.insert(s.tenants).values({ id: tenantId, name: "RS5 Co", slug: "rs5" });
    await tx.insert(s.parties).values([
      { id: customerId, tenantId, name: "RS5 Customer", code: "R-C", kind: "customer", currency: "USD" },
      { id: supplierId, tenantId, name: "RS5 Supplier", code: "R-S", kind: "supplier", currency: "USD" },
    ] as never);
    await tx.insert(s.fabrics).values({ id: fabricId, tenantId, name: "RS5 Cotton", minStockKg: "0" } as never);
    await tx.insert(s.colors).values({ id: colorId, tenantId, fabricId, name: "RS5 White" } as never);
  });
  await runWithTenantContext({ tenantId }, async () => {
    const roll = await new SqliteRollRepository(db).create(
      { colorId, rollNo: "RS5-1", initialKg: 50, remainingKg: 50, pieces: 10, pricePerKg: 4.25, currency: "USD", supplierId, entryDate: "2026-09-01" } as never,
      ctx as never,
    );
    const inv = await new SqliteInvoiceRepository(db).create(
      { type: "sale", date: "2026-09-10", partyId: customerId, partyType: "customer", currency: "USD", lines: [{ fabricId, colorId, rollId: roll.id, quantityKg: 12.5, pieces: 2, pricePerKg: 9.99 }], paid: 20, paymentMethod: "cash" } as never,
      ctx as never,
    );
    await new SqliteReturnRepository(db).create(
      { kind: "sale", date: "2026-09-12", partyId: customerId, originalInvoiceId: inv.id, reason: "defect", currency: "USD", lines: [{ rollId: roll.id, quantityKg: 1.5, pieces: 1, pricePerKg: 9.99 }] } as never,
      ctx as never,
    );
    await new SqliteVoucherRepository(db).create(
      { kind: "receipt", date: "2026-09-14", partyId: customerId, partyKind: "customer", amount: 30.5, discount: 0, currency: "USD", method: "cash" } as never,
      ctx as never,
    );
    await new SqliteCashboxRepository(db).addManualMovement(
      { date: "2026-09-15", type: "capital", direction: "in", amount: 1000, currency: "USD" } as never,
      ctx as never,
    );
  });

  const created = await backup.createAndVerifyBackup({ kind: "manual", appVersion: "test" });
  archive = created.path;
  const opened = backup.openAndVerifyBackupV3Sync(archive, { keep: true });
  archiveFigures = rs5.rs5Figures(opened.databasePath);
  rmSync(opened.workDir, { recursive: true, force: true });

  // change the live company after the backup
  await runWithTenantContext({ tenantId }, () =>
    new SqliteCashboxRepository(db).addManualMovement(
      { date: "2026-09-20", type: "withdrawal", direction: "out", amount: 75.25, currency: "USD" } as never,
      ctx as never,
    ),
  );
}, 120_000);

afterAll(() => {
  runtime?.shutdownSqliteRuntime();
  delete process.env.DESKTOP_SQLITE_MIGRATIONS_FOLDER;
  rmSync(root, { recursive: true, force: true });
});

describe("restore — staged, verified, atomic (RS-5)", () => {
  it("the archive carries real business figures (non-trivial RS-5 set)", () => {
    expect(Object.keys(archiveFigures).filter((k) => !k.startsWith("rows:")).length).toBeGreaterThanOrEqual(8);
    expect(rs5.rs5Diff(archiveFigures, rs5.rs5Figures(livePath()))).not.toEqual([]); // live changed since
  });

  for (const step of ["VERIFY_ARCHIVE", "SAFETY_BACKUP", "EXTRACT_STAGING", "MIGRATE_STAGING", "VERIFY_STAGING", "CARRY_OVER_DEVICE_STATE", "SWAP"] as const) {
    it(`a forced failure at ${step} leaves the live database byte-identical`, async () => {
      const before = liveImage();
      await expect(restore.restoreBackupV3(archive, { failAt: step })).rejects.toThrow(new RegExp(`RESTORE_FAILED at ${step}`));
      expect(runtime.getSqliteRuntime(), "the live database stays open").toBeTruthy();
      expect(liveImage()).toBe(before);
      expect(existsSync(`${livePath()}.restore-staging`)).toBe(false);
    });
  }

  it("a completed restore shows exactly the archive's RS-5 figures", async () => {
    const report = await restore.restoreBackupV3(archive);
    expect(report.safetyBackup && existsSync(report.safetyBackup)).toBe(true);
    expect(rs5.rs5Diff(archiveFigures, rs5.rs5Figures(livePath()))).toEqual([]);
  });

  it("an archive one migration behind is migrated on staging, then swapped in", async () => {
    // a binary one migration ahead of the archive (same mechanism as tests/sqlite/connection.test.ts)
    const { resolveSqliteMigrationsFolder } = runtime;
    const { readSqliteFingerprint } = await import("@/infrastructure/orm/sqlite/schemaFingerprint.js");
    const mig2 = join(root, "mig2");
    cpSync(resolveSqliteMigrationsFolder(), mig2, { recursive: true });
    const journal = JSON.parse(readFileSync(join(mig2, "meta", "_journal.json"), "utf8"));
    const next = journal.entries.at(-1).idx + 1;
    const tag = `${String(next).padStart(4, "0")}_rs5_probe`;
    writeFileSync(join(mig2, `${tag}.sql`), `CREATE TABLE "motard_rs5_probe" ("id" INTEGER NOT NULL, CONSTRAINT "motard_rs5_probe_pkey" PRIMARY KEY ("id")) STRICT;`);
    journal.entries.push({ idx: next, tag });
    writeFileSync(join(mig2, "meta", "_journal.json"), JSON.stringify(journal));
    const scratch = new Database(":memory:");
    scratch.pragma("trusted_schema = OFF");
    for (const e of journal.entries) scratch.exec(readFileSync(join(mig2, `${e.tag}.sql`), "utf8"));
    writeFileSync(join(mig2, "meta", "schema-fingerprint.json"), JSON.stringify(readSqliteFingerprint(scratch, next)));
    scratch.close();

    // the app is updated: it restarts on the newer binary (its migrations apply to the live file)
    runtime.shutdownSqliteRuntime();
    process.env.DESKTOP_SQLITE_MIGRATIONS_FOLDER = mig2;
    const { config } = await import("@/infrastructure/config/env.js");
    (config as { MOTARD_STARTUP_STATE?: string }).MOTARD_STARTUP_STATE = "REUSE";
    const boot = await runtime.ensureSqliteRuntime();
    expect(boot.appliedMigrations).toEqual([tag]);
    // …then the user restores the backup taken before the update
    const report = await restore.restoreBackupV3(archive);
    expect(report.migrated).toEqual([tag]);
    const live = new Database(livePath(), { readonly: true });
    expect(live.prepare(`SELECT schema_journal_idx FROM motard_meta WHERE id = 1`).pluck().get()).toBe(next);
    expect(live.prepare(`SELECT count(*) FROM sqlite_master WHERE name = 'motard_rs5_probe'`).pluck().get()).toBe(1);
    live.close();
    // RS-5 after the migration: the business figures are the archive's
    expect(rs5.rs5Diff(archiveFigures, rs5.rs5Figures(livePath()))).toEqual([]);
    // the archive itself was never migrated
    const opened = backup.openAndVerifyBackupV3Sync(archive, { keep: true, maxJournalIdx: next });
    expect(opened.manifest.schema.journalIdx).toBe(next - 1);
    rmSync(opened.workDir, { recursive: true, force: true });
  });
});
