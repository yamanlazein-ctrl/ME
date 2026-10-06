/**
 * T043 (specs/001-desktop-sqlite-engine, research I-2 / R13d): every write that PostgreSQL commits on
 * its OWN pooled connection while the caller is inside a transaction ("autonomous") must have the
 * same durable effect on SQLite, where there is one writer. The primitive `runAutonomous` joins the
 * caller's transaction and is replayed in a fresh transaction after a ROLLBACK. One test per call site:
 *
 *   1. settle-invoices number: `allocateDocumentNumberForDevice` inside the settle `withTenantTx`
 *      — a settlement that fails still consumes its number (the next allocation is the next number);
 *   2. sync conflict rows (`SqliteSyncConflictStore.insertOpen`) survive the caller's rollback;
 *   3. sync tombstones (`SqliteSyncMaterializeStore.recordTombstone`) survive the caller's rollback;
 *   4. a nested `runInTransaction` joins the outer one as a savepoint (single writer): it is NOT
 *      autonomous and rolls back with it;
 *   5. no call site can deadlock the write gate: autonomous writes inside a held gate complete, and
 *      outside a transaction they commit on their own.
 * Own temporary data root; runs on either suite.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

const root = mkdtempSync(join(tmpdir(), "motard-autonomous-"));
process.env.DB_ENGINE = "sqlite";
process.env.SQLITE_PATH = join(root, "data", "motard.db");
process.env.MOTARD_STARTUP_STATE = "FRESH";
delete process.env.DATABASE_URL;
delete process.env.DESKTOP_SEED_PATH;

const tenantId = randomUUID();
let tx: typeof import("@/infrastructure/orm/sqlite/transaction.js");
let runtime: typeof import("@/infrastructure/orm/sqlite/runtime.js");
const count = async (q: ReturnType<typeof sql>) => Number(((await tx.sqliteDb().execute(q)).rows[0] as { n: number }).n);

beforeAll(async () => {
  runtime = await import("@/infrastructure/orm/sqlite/runtime.js");
  tx = await import("@/infrastructure/orm/sqlite/transaction.js");
  await runtime.ensureSqliteRuntime();
  await tx.runInTransaction(async (t) => {
    await t.execute(sql`INSERT INTO tenants (id, name, slug) VALUES (${tenantId}, 'Autonomous', 'autonomous')`);
  });
}, 60_000);

afterAll(() => {
  runtime?.shutdownSqliteRuntime();
  rmSync(root, { recursive: true, force: true });
});

const boom = () => {
  throw new Error("settlement failed after the number was allocated");
};

describe("autonomous writes — same durable effect as PostgreSQL's separate pooled connection", () => {
  it("1. a failed settlement still consumes its batch number (allocateDocumentNumberForDevice)", async () => {
    const { allocateDocumentNumberForDevice } = await import("@/infrastructure/repositories/sqlite/helpers/documentNumbers.js");
    const first = await allocateDocumentNumberForDevice("settlement", tenantId, null);
    let insideFailed: string | null = null;
    await expect(
      tx.withTenantTx(tenantId, async () => {
        insideFailed = await allocateDocumentNumberForDevice("settlement", tenantId, null);
        boom();
      }),
    ).rejects.toThrow(/settlement failed/);
    const next = await allocateDocumentNumberForDevice("settlement", tenantId, null);
    const seq = (n: string | null) => Number(String(n).split("-").at(-1));
    expect(seq(insideFailed)).toBe(seq(first) + 1);
    expect(seq(next)).toBe(seq(first) + 2); // the failed settlement's number is consumed, never reused
  });

  it("2. a sync conflict row recorded inside a transaction survives its rollback", async () => {
    const { SqliteSyncConflictStore } = await import("@/infrastructure/repositories/sqlite/SqliteSyncConflictStore.js");
    const store = new SqliteSyncConflictStore(tx.sqliteIndependentDb() as never);
    const opId = randomUUID();
    await expect(
      tx.withTenantTx(tenantId, async () => {
        await store.insertOpen({ tenantId, opId, entityType: "invoice", entityId: randomUUID(), operation: "update", baseVersion: 1, serverVersion: 2, localIntentJson: "{}" });
        boom();
      }),
    ).rejects.toThrow();
    expect(await count(sql`SELECT count(*) n FROM sync_conflicts WHERE tenant_id = ${tenantId} AND op_id = ${opId}`)).toBe(1);
  });

  it("3. a sync tombstone recorded inside a transaction survives its rollback", async () => {
    const { SqliteSyncMaterializeStore } = await import("@/infrastructure/repositories/sqlite/SqliteSyncMaterializeStore.js");
    const store = new SqliteSyncMaterializeStore(tx.sqliteIndependentDb() as never);
    const entityId = randomUUID();
    await expect(
      tx.withTenantTx(tenantId, async () => {
        await store.recordTombstone(tenantId, "party", entityId, randomUUID(), null);
        boom();
      }),
    ).rejects.toThrow();
    expect(await store.tombstoneExists(tenantId, "party", entityId)).toBe(true);
  });

  it("4. a nested runInTransaction is NOT autonomous: it joins as a savepoint and rolls back with the outer", async () => {
    const slug = `nested-${randomUUID().slice(0, 8)}`;
    await expect(
      tx.runInTransaction(async () => {
        await tx.runInTransaction(async (inner) => {
          await inner.execute(sql`INSERT INTO tenants (id, name, slug) VALUES (${randomUUID()}, 'nested', ${slug})`);
        });
        boom();
      }),
    ).rejects.toThrow();
    expect(await count(sql`SELECT count(*) n FROM tenants WHERE slug = ${slug}`)).toBe(0);
  });

  it("5. no deadlock: autonomous writes inside a held gate complete; outside a transaction they commit at once", async () => {
    const { allocateDocumentNumberForDevice } = await import("@/infrastructure/repositories/sqlite/helpers/documentNumbers.js");
    const withDeadline = <T>(p: Promise<T>) =>
      Promise.race([p, new Promise<never>((_, rej) => setTimeout(() => rej(new Error("DEADLOCK: gate never released")), 5_000))]);
    // inside a transaction (the gate is held by this async context)
    const inside = await withDeadline(tx.withTenantTx(tenantId, () => allocateDocumentNumberForDevice("settlement", tenantId, null)));
    expect(inside).toMatch(/-\d+$/);
    // 20 concurrent autonomous allocations + transactions interleaved: all finish, numbers unique
    const all = await withDeadline(
      Promise.all(
        Array.from({ length: 20 }, (_, i) =>
          i % 2 ? allocateDocumentNumberForDevice("settlement", tenantId, null) : tx.withTenantTx(tenantId, () => allocateDocumentNumberForDevice("settlement", tenantId, null)),
        ),
      ),
    );
    expect(new Set(all).size).toBe(20);
  });
});
