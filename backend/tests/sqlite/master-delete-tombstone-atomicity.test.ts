/**
 * F-03 (ERP_VERIFIED_ISSUES_AND_REMEDIATION_PLAN): the hub-side master delete
 * applied the DELETE and then recorded the tombstone as two SEPARATE steps
 * ("causally durable despite the absence of a single wrapping transaction").
 * A crash/failure between them leaves a deleted row with no tombstone, so a
 * stale create replayed later resurrects it.
 *
 * RED first: with sync_tombstones made unwritable, a delete unit whose
 * repository delete succeeds must ROLL BACK (the row must still exist).
 * Against the unmodified code the delete survives — this is the exposed window.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

const root = mkdtempSync(join(tmpdir(), "motard-f03-"));
process.env.DB_ENGINE = "sqlite";
process.env.SQLITE_PATH = join(root, "data", "motard.db");
process.env.MOTARD_STARTUP_STATE = "FRESH";
process.env.MOTARD_INSTALLATION_ID ??= randomUUID();
process.env.MOTARD_INSTALL_INSTANCE_ID ??= randomUUID();
process.env.MOTARD_DATA_ID ??= randomUUID();
delete process.env.DATABASE_URL;
delete process.env.DESKTOP_SEED_PATH;
const TENANT = randomUUID();

let runtime: typeof import("@/infrastructure/orm/sqlite/runtime.js");
let tx: typeof import("@/infrastructure/orm/sqlite/transaction.js");

beforeAll(async () => {
  runtime = await import("@/infrastructure/orm/sqlite/runtime.js");
  tx = await import("@/infrastructure/orm/sqlite/transaction.js");
  await runtime.ensureSqliteRuntime();
}, 120_000);

afterAll(async () => {
  runtime?.shutdownSqliteRuntime();
  rmSync(root, { recursive: true, force: true });
});

describe("master delete + tombstone atomicity (F-03)", () => {
  it("a delete whose tombstone write fails ROLLS BACK — the row survives", async () => {
    const w = runtime.getSqliteRuntime()!.conns.writer as unknown as import("better-sqlite3").Database;

    // Seed a fabric the unit will delete.
    const fabricId = randomUUID();
    await tx.runInTransaction(async (t) => {
      await t.execute(sql`INSERT INTO tenants (id, name, slug) VALUES (${TENANT}, 'شركة الذرية', 'f03')`);
      await t.execute(
        sql`INSERT INTO fabrics (id, tenant_id, name, min_stock_kg, version) VALUES (${fabricId}, ${TENANT}, 'قماش الذرية', 0, 1)`,
      );
    });

    // Make the tombstone write fail deterministically: break the table so any
    // INSERT violates its NOT NULL columns.
    await tx.runInTransaction(async (t) => {
      await t.execute(sql`DROP TABLE sync_tombstones`);
      await t.execute(sql`CREATE TABLE sync_tombstones (id TEXT NOT NULL)`); // every insert fails NOT NULL for the other columns
    });

    const { materializeSyncUnit } = await import("@/application/use-cases/sync/syncMaterialize.js");
    const { SqliteFabricRepository } = await import(
      "@/infrastructure/repositories/sqlite/SqliteFabricRepository.js"
    );
    // Production wiring (sqliteContainer.ts:79) builds repos on sqliteDb() —
    // the AMBIENT handle that joins the outer transaction. Using it here is
    // what makes the test exercise the real nesting semantics.
    const db = tx.sqliteDb() as never;
    const fabricRepo = new SqliteFabricRepository(db);

    const ctx = { tenantId: TENANT, userId: randomUUID(), userRole: "admin" } as never;
    const result = await materializeSyncUnit(
      db,
      { fabricRepo } as never,
      {
        entityType: "fabric",
        operation: "delete",
        payload: { entityType: "fabric", entityId: fabricId, operation: "delete" },
      },
      ctx,
      { opId: randomUUID(), syncDeviceId: null },
    );

    // The unit must NOT report success — the tombstone is part of the delete.
    expect(result.status).not.toBe("created");

    // THE invariant: the fabric must still exist (the delete rolled back with
    // the failed tombstone write). Against the unmodified code the delete has
    // already committed and the row is GONE — this assertion is the RED.
    const row = w.prepare(`SELECT id FROM fabrics WHERE id = ?`).get(fabricId);
    expect(row, "delete must roll back when the tombstone write fails").toBeTruthy();
  }, 120_000);
});
