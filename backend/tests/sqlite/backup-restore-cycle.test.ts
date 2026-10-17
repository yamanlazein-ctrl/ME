/**
 * Backup → restore → verify (SQLite / desktop engine).
 *
 * User-visible contract: after a successful restore the response carries the restored row counts
 * the settings screen reports, and those counts match what the application reads afterward.
 * A success message must never claim 0 records when the database holds data.
 *
 * The wipe is covered by the factory-reset path (shell), and the swap by restore-lifecycle.test.ts;
 * here the archive is restored over the live database, which is what the restore route does.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

const root = mkdtempSync(join(tmpdir(), "motard-cycle-"));
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
const PARTY_NAMES = ["عميل أول", "عميل ثانٍ", "مورد أول"];

let runtime: typeof import("@/infrastructure/orm/sqlite/runtime.js");
let tx: typeof import("@/infrastructure/orm/sqlite/transaction.js");
let restoreRoute: typeof import("@/presentation/routes/backup.route.js");
let archive = "";

async function partyCount(): Promise<number> {
  return tx.runInTransaction(async (t) => {
    const r = await t.execute<{ n: number }>(
      sql`SELECT count(*) AS n FROM parties WHERE tenant_id = ${tenantId}`,
    );
    return Number(r.rows[0]?.n ?? 0);
  });
}

beforeAll(async () => {
  runtime = await import("@/infrastructure/orm/sqlite/runtime.js");
  tx = await import("@/infrastructure/orm/sqlite/transaction.js");
  restoreRoute = await import("@/presentation/routes/backup.route.js");
  await runtime.ensureSqliteRuntime();
  await tx.runInTransaction(async (t) => {
    await t.execute(
      sql`INSERT INTO tenants (id, name, slug) VALUES (${tenantId}, ${"Cycle Co"}, ${"default"})`,
    );
  });
  const { SqlitePartyRepository } =
    await import("@/infrastructure/repositories/sqlite/SqlitePartyRepository.js");
  const repo = new SqlitePartyRepository(tx.sqliteDb() as never);
  const ctx = { tenantId, userId: randomUUID(), userRole: "admin", userName: "cycle" } as never;
  for (const [i, name] of PARTY_NAMES.entries()) {
    await repo.create(
      {
        kind: i === 2 ? "supplier" : "customer",
        name,
        code: `CY-${i}`,
        currency: "SYP",
        openingBalance: 1000 * (i + 1),
        openingCurrency: "SYP",
        openingDate: "2026-09-20",
      },
      ctx,
    );
  }
  const { createAndVerifyBackup } = await import("@/infrastructure/backup/sqliteBackup.js");
  archive = (await createAndVerifyBackup({ kind: "manual", appVersion: "test" })).path;
});

afterAll(async () => {
  const rt = runtime.getSqliteRuntime();
  if (rt) (await import("@/infrastructure/orm/sqlite/connection.js")).closeSqlite(rt.conns);
  process.env = saved;
  rmSync(root, { recursive: true, force: true });
});

describe("backup → restore → verify", () => {
  it("the seeded company is in the database before the backup is restored", async () => {
    expect(await partyCount()).toBe(PARTY_NAMES.length);
  });

  it("restore through the route reports the restored row counts, not zero", async () => {
    const report = await restoreRoute.restoreUploadedBackup(archive, tenantId, true);
    expect(report.restoredRows).toBeGreaterThan(0);
    expect(report.restoredRows).toBe(report.tables.reduce((a, t) => a + t.rows, 0));
    const parties = report.tables.find((t) => t.table === "parties");
    expect(parties?.rows).toBe(PARTY_NAMES.length);
  });

  it("the count the user sees matches what the application reads afterward", async () => {
    const report = await restoreRoute.restoreUploadedBackup(archive, tenantId, true);
    expect(await partyCount()).toBe(report.tables.find((t) => t.table === "parties")?.rows ?? -1);
  });
});
