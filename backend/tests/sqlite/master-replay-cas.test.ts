/**
 * S-03: a master update/delete replay compared the unit's base version with a READ of the row, then
 * wrote without re-checking it. Two devices' units are separate hub requests, so a newer edit can land
 * between the read and the write — the replay then overwrites (or deletes) that newer version.
 *
 * Reproduced deterministically: the repo's `findById` returns the version the unit was based on (v1)
 * while the row is already at v2 — exactly what the read sees when the other write commits after it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

const root = mkdtempSync(join(tmpdir(), "motard-s03-"));
process.env.DB_ENGINE = "sqlite";
process.env.SQLITE_PATH = join(root, "data", "motard.db");
process.env.MOTARD_STARTUP_STATE = "FRESH";
process.env.MOTARD_INSTALLATION_ID ??= randomUUID();
process.env.MOTARD_INSTALL_INSTANCE_ID ??= randomUUID();
process.env.MOTARD_DATA_ID ??= randomUUID();
delete process.env.DATABASE_URL;
delete process.env.DESKTOP_SEED_PATH;
const TENANT = randomUUID();
const FABRIC = randomUUID();
const COLOR = randomUUID();

let runtime: typeof import("@/infrastructure/orm/sqlite/runtime.js");
let tx: typeof import("@/infrastructure/orm/sqlite/transaction.js");

/** The real repository, except its read returns the row as the replay's base saw it (v1). */
function staleRead<R extends { findById: (id: string, ctx: never) => Promise<unknown> }>(repo: R): R {
  const real = repo.findById.bind(repo);
  repo.findById = (async (id: string, c: never) => {
    const row = (await real(id, c)) as Record<string, unknown> | null;
    return row ? { ...row, version: 1 } : row;
  }) as R["findById"];
  return repo;
}

const one = <T>(q: string, ...a: unknown[]) =>
  (runtime.getSqliteRuntime()!.conns.writer as unknown as import("better-sqlite3").Database).prepare(q).get(...a) as T;

beforeAll(async () => {
  runtime = await import("@/infrastructure/orm/sqlite/runtime.js");
  tx = await import("@/infrastructure/orm/sqlite/transaction.js");
  await runtime.ensureSqliteRuntime();
  await tx.runInTransaction(async (t) => {
    await t.execute(sql`INSERT INTO tenants (id, name, slug) VALUES (${TENANT}, 'S03', 's03')`);
    await t.execute(sql`INSERT INTO fabrics (id, tenant_id, name, version) VALUES (${FABRIC}, ${TENANT}, 'F', 2)`);
    await t.execute(sql`INSERT INTO colors (id, tenant_id, fabric_id, name) VALUES (${COLOR}, ${TENANT}, ${FABRIC}, 'C')`);
  });
}, 120_000);

afterAll(() => {
  runtime?.shutdownSqliteRuntime();
  rmSync(root, { recursive: true, force: true });
});

const ctx = () => ({ tenantId: TENANT, userId: randomUUID(), userRole: "admin" }) as never;

describe("master replay write-time version check (S-03)", () => {
  it("a delete based on v1 does not destroy the row once it is at v2", async () => {
    const { materializeSyncUnit } = await import("@/application/use-cases/sync/syncMaterialize.js");
    const { SqliteFabricRepository } = await import("@/infrastructure/repositories/sqlite/SqliteFabricRepository.js");
    const db = tx.sqliteDb() as never;
    const { runWithTenantContext } = await import("@/infrastructure/orm/tenant-context.js");
    // Production replays run inside the request's tenant context (the conflict record needs it).
    const r = await runWithTenantContext({ tenantId: TENANT } as never, () => materializeSyncUnit(
      db,
      { fabricRepo: staleRead(new SqliteFabricRepository(db)) } as never,
      { entityType: "fabric", operation: "delete", payload: { entityId: FABRIC, baseVersion: 1 } },
      ctx(),
      { opId: randomUUID(), syncDeviceId: null },
    ));
    expect(r, JSON.stringify(r)).toMatchObject({ status: "conflict" });
    expect(one(`SELECT id FROM fabrics WHERE id = ?`, FABRIC)).toBeTruthy();
    expect(one(`SELECT id FROM sync_tombstones WHERE entity_id = ?`, FABRIC)).toBeUndefined();
  }, 60_000);

  it("a roll update based on v1 does not overwrite the row once it is at v2", async () => {
    const rollId = randomUUID();
    const fabric2 = randomUUID();
    const color2 = randomUUID();
    await tx.runInTransaction(async (t) => {
      await t.execute(sql`INSERT INTO fabrics (id, tenant_id, name) VALUES (${fabric2}, ${TENANT}, 'F2')`);
      await t.execute(sql`INSERT INTO colors (id, tenant_id, fabric_id, name) VALUES (${color2}, ${TENANT}, ${fabric2}, 'C2')`);
      await t.execute(sql`
        INSERT INTO rolls (id, tenant_id, color_id, roll_no, initial_kg, remaining_kg, remaining_pieces, price_per_kg, entry_date, currency, dye_batch, version)
        VALUES (${rollId}, ${TENANT}, ${color2}, 'R-S03', 10000, 10000, 1, 50000, '2026-01-01', 'USD', 'NEWER', 2)`);
    });
    const { materializeSyncUnit } = await import("@/application/use-cases/sync/syncMaterialize.js");
    const { SqliteRollRepository } = await import("@/infrastructure/repositories/sqlite/SqliteRollRepository.js");
    const db = tx.sqliteDb() as never;
    const r = await materializeSyncUnit(
      db,
      { rollRepo: staleRead(new SqliteRollRepository(db)) } as never,
      { entityType: "roll", operation: "update", payload: { entityId: rollId, baseVersion: 1, updateInput: { dyeBatch: "STALE" } } },
      ctx(),
      { opId: randomUUID(), syncDeviceId: null },
    );
    expect(r.status).not.toBe("created");
    expect(one<{ b: string; v: number }>(`SELECT dye_batch AS b, version AS v FROM rolls WHERE id = ?`, rollId)).toEqual({ b: "NEWER", v: 2 });
  }, 60_000);
});
