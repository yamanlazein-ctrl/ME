/**
 * Roll quantity corrections (inventory count posting + manual adjustment):
 * difference = counted − book against a FRESH book snapshot, a post refuses when
 * the shelf moved since the count, and every change leaves an `adjustment`
 * movement, a non-cash P&L leg at cost and an audit row — kg and pieces alike.
 * The sync replay (expectedVersion null) applies the same delta on top of
 * whatever the receiving device already holds. Own temporary data root.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { TenantContext } from "@/domain/types/index.js";

const root = mkdtempSync(join(tmpdir(), "motard-adjust-"));
process.env.DB_ENGINE = "sqlite";
process.env.SQLITE_PATH = join(root, "data", "motard.db");
process.env.MOTARD_STARTUP_STATE = "FRESH";
delete process.env.DATABASE_URL;
delete process.env.DESKTOP_SEED_PATH;

const tenantId = randomUUID();
const colorId = randomUUID();
const ctx = { tenantId, userId: randomUUID(), userRole: "admin", userName: "tester" } as TenantContext;
let tx: typeof import("@/infrastructure/orm/sqlite/transaction.js");
let runtime: typeof import("@/infrastructure/orm/sqlite/runtime.js");
let h: Awaited<ReturnType<typeof import("@/infrastructure/repositories/engineHelpers.js").inventoryCountHelpers>>;

const run = <T>(fn: (t: never) => Promise<T>) => tx.runInTransaction((t) => fn(t as never));
const q = async <T>(query: ReturnType<typeof sql>) => (await tx.sqliteDb().execute(query)).rows as T[];

/** 100 kg / 10 pieces at 5 per kg. */
async function newRoll(): Promise<string> {
  const id = randomUUID();
  await run(async (t: never) => {
    await (t as { execute: (s: unknown) => Promise<unknown> }).execute(sql`
      INSERT INTO rolls (id, tenant_id, color_id, roll_no, initial_kg, remaining_kg, remaining_pieces, price_per_kg, entry_date, currency)
      VALUES (${id}, ${tenantId}, ${colorId}, ${`R-${id.slice(0, 6)}`}, 10000, 10000, 10, 50000, '2026-01-01', 'USD')`);
  });
  return id;
}
const roll = async (id: string) =>
  (
    await q<{ kg: number; pieces: number; version: number }>(
      sql`SELECT CAST(remaining_kg AS REAL) / 100 AS kg, remaining_pieces AS pieces, version FROM rolls WHERE id = ${id}`,
    )
  )[0];

beforeAll(async () => {
  runtime = await import("@/infrastructure/orm/sqlite/runtime.js");
  tx = await import("@/infrastructure/orm/sqlite/transaction.js");
  await runtime.ensureSqliteRuntime();
  const fabricId = randomUUID();
  await tx.runInTransaction(async (t) => {
    await t.execute(sql`INSERT INTO tenants (id, name, slug) VALUES (${tenantId}, 'Adjust', 'adjust')`);
    await t.execute(sql`INSERT INTO fabrics (id, tenant_id, name) VALUES (${fabricId}, ${tenantId}, 'F')`);
    await t.execute(sql`INSERT INTO colors (id, tenant_id, fabric_id, name) VALUES (${colorId}, ${tenantId}, ${fabricId}, 'C')`);
  });
  h = await (await import("@/infrastructure/repositories/engineHelpers.js")).inventoryCountHelpers();
}, 60_000);

afterAll(() => {
  runtime?.shutdownSqliteRuntime();
  rmSync(root, { recursive: true, force: true });
});

const countId = async (rollId: string) =>
  (await q<{ id: string; book: number; diff: number }>(
    sql`SELECT id, CAST(book_kg AS REAL) / 100 AS book, CAST(diff_kg AS REAL) / 100 AS diff FROM inventory_counts WHERE roll_id = ${rollId}`,
  ))[0];

describe("inventory count → posted variance", () => {
  it("difference is counted − book, applied with movement, P&L leg and audit (kg + pieces)", async () => {
    const id = await newRoll();
    const { diffKg } = await run((t) => h.recordCount(t, ctx, 2026, id, 92, 9, "عجز"));
    expect(diffKg).toBe(-8);
    const c = await countId(id);
    const posted = await run((t) => h.postCountVariance(t, ctx, c.id));
    expect(posted.diffKg).toBe(-8);
    expect(posted.adjustment).toMatchObject({ deltaKg: -8, deltaPieces: -1, referenceType: "inventory_count" });
    expect(await roll(id)).toMatchObject({ kg: 92, pieces: 9, version: 2 });

    const mv = await q<{ type: string; dir: string; kg: number; after: number }>(
      sql`SELECT movement_type AS type, direction AS dir, CAST(quantity_kg AS REAL) / 100 AS kg, CAST(balance_after_kg AS REAL) / 100 AS after FROM stock_movements WHERE roll_id = ${id}`,
    );
    expect(mv).toEqual([{ type: "adjustment", dir: "out", kg: 8, after: 92 }]);
    const led = await q<{ debit: number; cash: string; currency: string }>(
      sql`SELECT CAST(debit AS REAL) / 100 AS debit, cash_impact AS cash, currency FROM ledger_entries WHERE reference_id = ${c.id}`,
    );
    expect(led).toEqual([{ debit: 40, cash: "none", currency: "USD" }]);
    const audit = await q<{ action: string; after: string }>(
      sql`SELECT action, after_snapshot AS after FROM audit_logs WHERE module = 'inventory_adjustments' AND entity_id = ${id}`,
    );
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe("post_count_variance");
    expect(JSON.parse(audit[0].after)).toMatchObject({ remainingKg: 92, remainingPieces: 9, deltaKg: -8, deltaPieces: -1 });

    await expect(run((t) => h.postCountVariance(t, ctx, c.id))).rejects.toThrow(/مسبقاً/);
  });

  it("a re-count takes a fresh book snapshot; a post after the shelf moved is refused untouched", async () => {
    const id = await newRoll();
    await run((t) => h.recordCount(t, ctx, 2026, id, 95, null, undefined));
    // A sale moves the shelf after the count.
    await run((t) => h.applyRollAdjustment(t, ctx, {
      rollId: id, deltaKg: -10, deltaPieces: -1, reason: "بيع", date: "2026-02-01",
      referenceType: "inventory_adjustment", referenceId: randomUUID(), referenceNumber: "ADJ-T", expectedVersion: null,
    }));
    const stale = await countId(id);
    const sheet = await run((t) => h.getCountSheet(t, ctx, 2026, { limit: 500 }));
    expect(sheet.lines.find((l) => l.rollId === id)).toMatchObject({ bookKg: 90, countedKg: 95, diffKg: 5, bookPieces: 9 });
    await expect(run((t) => h.postCountVariance(t, ctx, stale.id))).rejects.toThrow(/أعد عدّ/);
    expect(await roll(id)).toMatchObject({ kg: 90, pieces: 9 });

    await run((t) => h.recordCount(t, ctx, 2026, id, 88, null, undefined));
    const fresh = await countId(id);
    expect(fresh).toMatchObject({ book: 90, diff: -2 });
    await run((t) => h.postCountVariance(t, ctx, fresh.id));
    expect((await roll(id)).kg).toBe(88);
  });
});

describe("manual roll adjustment", () => {
  const input = (rollId: string, deltaKg: number, deltaPieces: number, expectedVersion: number | null) => ({
    rollId, deltaKg, deltaPieces, reason: "تصحيح", date: "2026-03-01",
    referenceType: "inventory_adjustment" as const, referenceId: randomUUID(), referenceNumber: "ADJ-1", expectedVersion,
  });

  it("refuses a stale version, a no-op and a negative result without touching the roll", async () => {
    const id = await newRoll();
    await expect(run((t) => h.applyRollAdjustment(t, ctx, input(id, 1, 0, 99)))).rejects.toThrow(/جهاز آخر/);
    await expect(run((t) => h.applyRollAdjustment(t, ctx, input(id, 0, 0, 1)))).rejects.toThrow(/لا يوجد تغيير/);
    await expect(run((t) => h.applyRollAdjustment(t, ctx, input(id, -101, 0, 1)))).rejects.toThrow(/سالبة/);
    expect(await roll(id)).toMatchObject({ kg: 100, pieces: 10, version: 1 });
  });

  it("pieces-only change: no movement or P&L, but audited and versioned", async () => {
    const id = await newRoll();
    const r = await run((t) => h.applyRollAdjustment(t, ctx, input(id, 0, 2, 1)));
    expect(r.movementId).toBeNull();
    expect(await roll(id)).toMatchObject({ kg: 100, pieces: 12, version: 2 });
    const audit = await q<{ action: string }>(sql`SELECT action FROM audit_logs WHERE entity_id = ${id}`);
    expect(audit.map((a) => a.action)).toEqual(["roll_adjust"]);
  });

  it("sync replay (no version) applies the delta on top of the receiver's state", async () => {
    const id = await newRoll();
    await run((t) => h.applyRollAdjustment(t, ctx, input(id, -30, 0, 1))); // a local sale-like change
    await run((t) => h.applyRollAdjustment(t, ctx, input(id, 5, 1, null))); // replayed from another device
    expect(await roll(id)).toMatchObject({ kg: 75, pieces: 11, version: 3 });
  });
});
