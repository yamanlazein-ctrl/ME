/**
 * Master-data edits through sync (corrective plan steps 2–4).
 *
 * Field evidence (hub, 2026-10-07): colour edits died after 5 attempts as "stale base"
 * because the base was an updatedAt stamped by each node's own clock, and a party edit
 * died on the unique code index because it re-sent a `code` the hub had renamed.
 * Now: colour/fabric edits carry a version base, a hub-canonical replay aligns the local
 * version, only changed fields travel, and an unappliable edit is a `conflict` at once.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import type { TenantContext } from "@/domain/types/index.js";

const root = mkdtempSync(join(tmpdir(), "motard-master-edit-"));
process.env.DB_ENGINE = "sqlite";
process.env.SQLITE_PATH = join(root, "data", "motard.db");
process.env.MOTARD_STARTUP_STATE = "FRESH";
delete process.env.DATABASE_URL;
delete process.env.DESKTOP_SEED_PATH;

const tenantId = randomUUID();
const fabricId = randomUUID();
const colorId = randomUUID();
const ctx = {
  tenantId,
  userId: randomUUID(),
  userRole: "admin",
  userName: "tester",
} as TenantContext;
let tx: typeof import("@/infrastructure/orm/sqlite/transaction.js");
let runtime: typeof import("@/infrastructure/orm/sqlite/runtime.js");
let materialize: typeof import("@/application/use-cases/sync/syncMaterialize.js").materializeSyncUnit;
let runWithTenantContext: typeof import("@/infrastructure/orm/tenant-context.js").runWithTenantContext;
let repos: import("@/application/use-cases/sync/syncMaterialize.js").SyncMaterializeRepos;
let db: never;

const q = async <T>(query: ReturnType<typeof sql>) =>
  (await tx.sqliteDb().execute(query)).rows as T[];
const colorRow = async () =>
  (
    await q<{ name: string; version: number }>(
      sql`SELECT name, version FROM colors WHERE id = ${colorId}`,
    )
  )[0];
const apply = (
  operation: string,
  entityType: string,
  payload: Record<string, unknown>,
  hubCanonical = false,
) =>
  runWithTenantContext({ tenantId }, () =>
    materialize(db, repos, { entityType, operation, payload }, ctx, {
      opId: randomUUID(),
      syncDeviceId: null,
      ...(hubCanonical ? { hubCanonical: true } : {}),
      // SYNC-06: the origin actor NAME travels through meta (display context),
      // never as authority — the audit actor_id stays the receiver's user.
      originActorName:
        typeof payload.actorUserName === "string" && payload.actorUserName.trim()
          ? payload.actorUserName.trim().slice(0, 255)
          : null,
    } as never),
  );

beforeAll(async () => {
  runtime = await import("@/infrastructure/orm/sqlite/runtime.js");
  tx = await import("@/infrastructure/orm/sqlite/transaction.js");
  await runtime.ensureSqliteRuntime();
  await tx.runInTransaction(async (t) => {
    await t.execute(sql`INSERT INTO tenants (id, name, slug) VALUES (${tenantId}, 'Edit', 'edit')`);
    await t.execute(
      sql`INSERT INTO fabrics (id, tenant_id, name) VALUES (${fabricId}, ${tenantId}, 'F')`,
    );
    await t.execute(
      sql`INSERT INTO colors (id, tenant_id, fabric_id, name, code) VALUES (${colorId}, ${tenantId}, ${fabricId}, 'اسود', 'BLK')`,
    );
  });
  materialize = (await import("@/application/use-cases/sync/syncMaterialize.js"))
    .materializeSyncUnit;
  runWithTenantContext = (await import("@/infrastructure/orm/tenant-context.js"))
    .runWithTenantContext;
  db = tx.sqliteIndependentDb() as never;
  const { SqliteColorRepository } =
    await import("@/infrastructure/repositories/sqlite/SqliteColorRepository.js");
  const { SqliteFabricRepository } =
    await import("@/infrastructure/repositories/sqlite/SqliteFabricRepository.js");
  const { SqlitePartyRepository } =
    await import("@/infrastructure/repositories/sqlite/SqlitePartyRepository.js");
  const { SqliteAuditRepository } =
    await import("@/infrastructure/repositories/sqlite/SqliteAuditRepository.js");
  repos = {
    colorRepo: new SqliteColorRepository(db),
    fabricRepo: new SqliteFabricRepository(db),
    partyRepo: new SqlitePartyRepository(db),
    auditRepo: new SqliteAuditRepository(db),
  } as never;
}, 60_000);

afterAll(() => {
  runtime?.shutdownSqliteRuntime();
  rmSync(root, { recursive: true, force: true });
});

describe("master edits through sync", () => {
  it("only changed fields travel; an untouched code is never re-sent", async () => {
    const { changedFields } = await import("@/application/use-cases/sync/syncEnqueue.js");
    const before = { code: "CUS-2026-0001", name: "علي", creditLimit: "0", tags: ["a"] };
    expect(
      changedFields({ code: "CUS-2026-0001", name: "علي ح", creditLimit: 0, tags: ["a"] }, before),
    ).toEqual({
      name: "علي ح",
    });
    expect(changedFields({ name: "x" }, null)).toEqual({ name: "x" });
  });

  it("a colour edit with a matching version base applies on the hub at the first attempt", async () => {
    const r = await apply("update", "color", {
      entityId: colorId,
      baseVersion: 1,
      updateInput: { name: "أسود فاحم" },
    });
    expect(r.status).toBe("created");
    expect(await colorRow()).toMatchObject({ name: "أسود فاحم", version: 2 });
  });

  it("a stale colour edit is a conflict at once, never a retryable failure", async () => {
    const r = await apply("update", "color", {
      entityId: colorId,
      baseVersion: 1,
      updateInput: { name: "قديم" },
    });
    expect(r.status).toBe("conflict");
    expect((await colorRow()).name).toBe("أسود فاحم");
  });

  it("a hub-canonical replay aligns the local version to the hub's (base + 1)", async () => {
    // This device drifted (v5) — the hub accepted base v2, so the hub row is v3 now.
    await q(sql`UPDATE colors SET version = 5 WHERE id = ${colorId}`);
    const r = await apply(
      "update",
      "color",
      { entityId: colorId, baseVersion: 2, updateInput: { name: "كحلي" } },
      true,
    );
    expect(r.status).toBe("created");
    expect(await colorRow()).toMatchObject({ name: "كحلي", version: 3 });
  });

  it("an edit that breaks a unique code is a conflict, not five SQL retries", async () => {
    const a = randomUUID();
    const b = randomUUID();
    await q(
      sql`INSERT INTO parties (id, tenant_id, kind, code, name, currency) VALUES (${a}, ${tenantId}, 'customer', 'CUS-2026-0001', 'زبون أ', 'USD')`,
    );
    await q(
      sql`INSERT INTO parties (id, tenant_id, kind, code, name, currency) VALUES (${b}, ${tenantId}, 'customer', 'CUS-2026-0001-6868', 'علي', 'USD')`,
    );
    const r = await apply("update", "party", {
      entityId: b,
      baseVersion: 1,
      updateInput: { code: "CUS-2026-0001" },
    });
    expect(r.status).toBe("conflict");
  });

  it("the hub answers a stale edit with a conflict at once — no 5-attempt retry series", async () => {
    const { receiveSyncPush } = await import("@/application/use-cases/sync/syncUseCases.js");
    const rows = new Map<string, Record<string, unknown>>();
    const set = (opId: string, patch: Record<string, unknown>) => {
      rows.set(opId, { ...rows.get(opId)!, ...patch });
      return rows.get(opId) as never;
    };
    const inbox = {
      receive: async (i: Record<string, unknown>) => {
        const created = !rows.has(i.opId as string);
        if (created)
          rows.set(i.opId as string, {
            ...i,
            id: randomUUID(),
            status: "received",
            applyAttempts: 0,
          });
        return { row: rows.get(i.opId as string), created };
      },
      findByOpId: async (_t: string, opId: string) => rows.get(opId) ?? null,
      markRejected: async (_t: string, opId: string, reason: string) =>
        set(opId, { status: "rejected", rejectReason: reason }),
      markApplied: async (_t: string, opId: string) => set(opId, { status: "applied" }),
      markDead: async (_t: string, opId: string) => set(opId, { status: "dead" }),
      setMaterializeError: async (_t: string, opId: string) =>
        set(opId, { applyAttempts: ((rows.get(opId)?.applyAttempts as number) ?? 0) + 1 }),
    };
    const claims = {
      tryClaimAll: async () => ({ ok: true, conflicts: [] }),
      releaseByOp: async () => 0,
    };
    const current = (await colorRow()).version;
    const opId = randomUUID();
    const r = await runWithTenantContext({ tenantId }, () =>
      receiveSyncPush(
        inbox as never,
        claims as never,
        { create: async () => undefined } as never,
        repos,
        db,
        {
          tenantId: tenantId as never,
          syncDeviceId: null,
          opId: opId as never,
          entityType: "color",
          entityId: colorId,
          operation: "update",
          payload: { entityId: colorId, baseVersion: current - 1, updateInput: { name: "متأخر" } },
          hubCtx: ctx,
        },
      ),
    );
    expect(r.accepted).toBe(false);
    expect(rows.get(opId)).toMatchObject({ status: "rejected", applyAttempts: 0 });
    expect((await colorRow()).name).not.toBe("متأخر");
  });

  it("two devices creating the same fabric (and colour) name converge with a visible suffix", async () => {
    const make = (entityType: string, snapshot: Record<string, unknown>) => apply("create", entityType, { snapshot });
    const f1 = "00000000-0000-4000-8000-00000000f001"; // smaller id keeps the name
    const f2 = "ffffffff-0000-4000-8000-00000000f002";
    expect((await make("fabric", { id: f2, name: "ميني ليكرا" })).status).toBe("created");
    expect((await make("fabric", { id: f1, name: "ميني ليكرا" })).status).toBe("created");
    const fabricNames = await q<{ id: string; name: string }>(sql`SELECT id, name FROM fabrics WHERE id IN (${f1}, ${f2}) ORDER BY id`);
    expect(fabricNames[0].name).toBe("ميني ليكرا");
    expect(fabricNames[1].name).toMatch(/^ميني ليكرا \(/);
    const c1 = "00000000-0000-4000-8000-00000000c001";
    const c2 = "ffffffff-0000-4000-8000-00000000c002";
    expect((await make("color", { id: c1, fabricId: f1, name: "أسود", code: "BLK" })).status).toBe("created");
    expect((await make("color", { id: c2, fabricId: f1, name: "أسود", code: "BLK" })).status).toBe("created");
    const colorNames = await q<{ name: string }>(sql`SELECT name FROM colors WHERE id IN (${c1}, ${c2}) ORDER BY id`);
    expect(colorNames.map((c) => c.name)).toEqual(["أسود", expect.stringMatching(/^أسود \(/)]);
  });

  it("a synced roll adjustment keeps the real creator from the source device", async () => {
    const rollId = randomUUID();
    await q(sql`INSERT INTO rolls (id, tenant_id, color_id, roll_no, initial_kg, remaining_kg, remaining_pieces, price_per_kg, entry_date, currency)
                VALUES (${rollId}, ${tenantId}, ${colorId}, ${"R-" + rollId.slice(0, 6)}, 5000, 5000, 5, 1000, '2026-01-01', 'USD')`);
    const origin = randomUUID();
    const r = await apply("adjust", "roll", {
      rollId, deltaKg: -2, deltaPieces: -1, reason: "تلف", date: "2026-10-07",
      referenceType: "inventory_adjustment", referenceId: randomUUID(), referenceNumber: "ADJ-X",
      actorUserId: origin, actorUserName: "سامر (المستودع)",
    });
    expect(r.status).toBe("created");
    const [audit] = await q<{ actor_id: string; actor_name: string; after: string }>(
      sql`SELECT actor_id, actor_name, after_snapshot AS after FROM audit_logs WHERE entity_id = ${rollId}`,
    );
    // SYNC-06/P6: a wire actorUserId is NEVER the audit identity (it would let a
    // forged push attribute work to a stranger). The origin device survives as the
    // display name; the actor id stays the authenticated receiver's user.
    expect(audit).toMatchObject({ actor_id: ctx.userId, actor_name: "سامر (المستودع)" });
    expect(JSON.parse(audit.after)).toMatchObject({ syncedFrom: "device", appliedBy: "tester" });
    // Authority / FK columns stay the receiver's.
    const [mv] = await q<{ by: string }>(sql`SELECT created_by AS by FROM stock_movements WHERE roll_id = ${rollId}`);
    expect(mv.by).toBe(ctx.userId);
  });
});
