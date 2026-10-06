/**
 * Phase 2 — recordSyncConflict must not swallow insert failures.
 */
import { describe, expect, it, vi, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const query = vi.hoisted(() => vi.fn());

vi.mock("../src/infrastructure/orm/drizzle.js", () => ({
  pool: { query: (...args: unknown[]) => query(...args) },
}));

/**
 * Arrange the conflict-store insert outcome. PG: the store's pool.query (mocked above). SQLite: the
 * store writes through runAutonomous on the independent handle, and engineStores loads it with a
 * dynamic import that a module mock does not reach — so the cached store instance itself is stubbed.
 * Either way the use case sees the same insert outcome, and both engines prove the same contract.
 */
async function arrangeInsert(outcome: { reject: Error } | { rowCount: number }): Promise<void> {
  if (process.env.DB_ENGINE === "sqlite") {
    // The store is built on the runtime's handles; the server boots the runtime at start, a unit test here.
    const { ensureSqliteRuntime } = await import("../src/infrastructure/orm/sqlite/runtime.js");
    await ensureSqliteRuntime();
    const { getSyncConflictStore } = await import("../src/infrastructure/repositories/engineStores.js");
    const store = await getSyncConflictStore();
    const spy = vi.spyOn(store, "insertOpen");
    if ("reject" in outcome) spy.mockRejectedValueOnce(outcome.reject);
    else spy.mockResolvedValueOnce(outcome.rowCount);
    return;
  }
  if ("reject" in outcome) query.mockRejectedValueOnce(outcome.reject);
  else query.mockResolvedValueOnce({ rowCount: outcome.rowCount, rows: [] });
}

describe("recordSyncConflict fail-closed (Phase 2)", () => {
  beforeEach(() => {
    query.mockReset();
  });

  it("propagates a transient insert failure (no silent false)", async () => {
    const { runWithTenantContext } = await import("../src/infrastructure/orm/tenant-context.js");
    const { recordSyncConflict } = await import(
      "../src/application/use-cases/sync/syncConflicts.js"
    );
    await arrangeInsert({ reject: new Error("transient insert failure") });
    await expect(
      runWithTenantContext({ tenantId: "11111111-1111-4111-8111-111111111111" }, () =>
        recordSyncConflict({
          tenantId: "11111111-1111-4111-8111-111111111111",
          opId: "22222222-2222-4222-8222-222222222222",
          entityType: "invoice",
          entityId: "33333333-3333-4333-8333-333333333333",
          operation: "update",
          baseVersion: 1,
          serverVersion: 2,
          localIntent: { foo: 1 },
        }),
      ),
    ).rejects.toThrow(/transient insert failure/);
  });

  it("returns true when a new row is written", async () => {
    const { runWithTenantContext } = await import("../src/infrastructure/orm/tenant-context.js");
    const { recordSyncConflict } = await import(
      "../src/application/use-cases/sync/syncConflicts.js"
    );
    await arrangeInsert({ rowCount: 1 });
    const wrote = await runWithTenantContext(
      { tenantId: "11111111-1111-4111-8111-111111111111" },
      () =>
        recordSyncConflict({
          tenantId: "11111111-1111-4111-8111-111111111111",
          opId: "22222222-2222-4222-8222-222222222222",
          entityType: "invoice",
          entityId: "33333333-3333-4333-8333-333333333333",
          operation: "update",
          baseVersion: 1,
          serverVersion: 2,
          localIntent: { foo: 1 },
        }),
    );
    expect(wrote).toBe(true);
  });

  it("source no longer contains the best-effort catch", () => {
    const HERE = dirname(fileURLToPath(import.meta.url));
    const SRC = readFileSync(
      resolve(HERE, "../src/application/use-cases/sync/syncConflicts.ts"),
      "utf8",
    );
    const fn = SRC.slice(SRC.indexOf("export async function recordSyncConflict"));
    const body = fn.slice(0, fn.indexOf("export async function listSyncConflicts"));
    expect(body).not.toContain("best-effort");
    expect(body).not.toMatch(/return false/);
  });

  it("claim conflict records before markRejected (syncUseCases)", () => {
    const HERE = dirname(fileURLToPath(import.meta.url));
    const UC = readFileSync(
      resolve(HERE, "../src/application/use-cases/sync/syncUseCases.ts"),
      "utf8",
    );
    const claimIdx = UC.indexOf("Track the update/cancel loser in the conflict ledger");
    const rejectIdx = UC.indexOf("inbox.markRejected", claimIdx);
    const recordIdx = UC.indexOf("await recordSyncConflict", claimIdx);
    expect(claimIdx).toBeGreaterThan(-1);
    expect(recordIdx).toBeGreaterThan(-1);
    expect(rejectIdx).toBeGreaterThan(-1);
    expect(recordIdx).toBeLessThan(rejectIdx);
  });
});
