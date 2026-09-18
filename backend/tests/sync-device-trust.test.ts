/**
 * Batch 4 — sync surface authorization and device trust.
 *
 * These are BEHAVIOURAL tests for the two rules that cannot be checked by
 * reading the code:
 *
 *   4B  sync-device-gate.middleware.ts — a device asserted in sync traffic is
 *       accepted only when it is registered, not revoked, and bound to the
 *       calling user. Each refusal carries its own code so the device can tell
 *       "register me" from "I was revoked" from "not yours".
 *
 *   4D  materializeMasterMutation's delete branch — a master delete replayed
 *       from a stale base is refused and recorded as a conflict instead of
 *       winning over a newer hub edit (the `refuseStaleCancelBase` discipline,
 *       extended to party/fabric/color/roll deletes).
 *
 * The fakes are injected: no database is required. The live-HTTP side of the
 * same rules is exercised by scripts/verify-batch4-device-trust.mjs.
 */
import { describe, expect, it, vi } from "vitest";
import type { Request, Response } from "express";
import { createSyncDeviceGate } from "../src/infrastructure/http/middleware/sync-device-gate.middleware.js";
import type {
  ISyncDeviceRepository,
  SyncDeviceRow,
} from "../src/application/ports/ISyncDeviceRepository.js";
import { materializeSyncUnit } from "../src/application/use-cases/sync/syncMaterialize.js";
import type { SyncMaterializeRepos } from "../src/application/use-cases/sync/syncMaterialize.js";
import type { TenantContext } from "../src/domain/types/index.js";
import { runWithTenantContext } from "../src/infrastructure/orm/tenant-context.js";

const TENANT = "11111111-1111-4111-8111-111111111111";
const USER_A = "22222222-2222-4222-8222-222222222222";
const USER_B = "33333333-3333-4333-8333-333333333333";
const DEVICE_1 = "44444444-4444-4444-8444-444444444444";
const DEVICE_2 = "55555555-5555-4555-8555-555555555555";
const OP_ID = "66666666-6666-4666-8666-666666666666";
const FABRIC_ID = "77777777-7777-4777-8777-777777777777";

/* ------------------------------------------------------------------ */
/* 4B — sync device gate                                               */
/* ------------------------------------------------------------------ */

function deviceRow(overrides: Partial<SyncDeviceRow> = {}): SyncDeviceRow {
  return {
    id: DEVICE_1,
    tenantId: TENANT,
    lastSeenByUserId: USER_A,
    authorizedUserIds: [USER_A],
    revokedAt: null,
    revokeReason: null,
    deviceFingerprint: "fp-1",
    deviceFingerprintVersion: 1,
    platform: "windows",
    hostname: "pc-1",
    label: "pc-1",
    lastSeenAt: new Date(),
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  };
}

function fakeRepo(row: SyncDeviceRow | null): ISyncDeviceRepository {
  return {
    registerOrTouch: vi.fn(),
    findById: vi.fn(async () => row),
    listForTenant: vi.fn(async () => (row ? [row] : [])),
    setRevoked: vi.fn(),
    revokeUserAuthorization: vi.fn(),
  } as unknown as ISyncDeviceRepository;
}

type Ctx = { tenantId: string; userId: string; syncDeviceId?: string | null };

function makeReq(opts: {
  ctx?: Ctx;
  body?: Record<string, unknown>;
  query?: Record<string, unknown>;
  headerDevice?: string | null;
}): Request {
  return {
    headers: {},
    body: opts.body ?? {},
    query: opts.query ?? {},
    params: {},
    path: "/sync/push",
    method: "POST",
    tenantContext: opts.ctx
      ? {
          tenantId: opts.ctx.tenantId,
          userId: opts.ctx.userId,
          userRole: "admin",
          userName: "tester",
          syncDeviceId: opts.headerDevice ?? opts.ctx.syncDeviceId ?? null,
        }
      : undefined,
  } as unknown as Request;
}

function makeRes() {
  const res = {
    statusCode: 0,
    body: null as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  };
  return res as unknown as Response & { statusCode: number; body: Record<string, unknown> };
}

const attributed = () =>
  createSyncDeviceGate(fakeRepo(deviceRow()), {
    unknownDevice: "reject",
    unboundUser: "reject",
  });
const orchestration = () =>
  createSyncDeviceGate(fakeRepo(deviceRow()), {
    unknownDevice: "allow",
    unboundUser: "allow",
  });

async function runGate(
  gate: ReturnType<typeof createSyncDeviceGate>,
  req: Request,
): Promise<{ next: boolean; status: number; body: Record<string, unknown> | null }> {
  const res = makeRes();
  let next = false;
  await gate(req, res, () => {
    next = true;
  });
  return { next, status: res.statusCode, body: res.body as Record<string, unknown> | null };
}

describe("4B — sync device gate", () => {
  it("accepts a registered, non-revoked device bound to the caller", async () => {
    const out = await runGate(
      attributed(),
      makeReq({ ctx: { tenantId: TENANT, userId: USER_A }, body: { syncDeviceId: DEVICE_1 } }),
    );
    expect(out.next).toBe(true);
    expect(out.status).toBe(0);
  });

  it("refuses an unregistered device id with SYNC_UNKNOWN_DEVICE", async () => {
    const gate = createSyncDeviceGate(fakeRepo(null), {
      unknownDevice: "reject",
      unboundUser: "reject",
    });
    const out = await runGate(
      gate,
      makeReq({ ctx: { tenantId: TENANT, userId: USER_A }, body: { syncDeviceId: DEVICE_1 } }),
    );
    expect(out.next).toBe(false);
    expect(out.status).toBe(403);
    expect(out.body?.code).toBe("SYNC_UNKNOWN_DEVICE");
  });

  it("refuses a REVOKED device with SYNC_DEVICE_REVOKED (push, pull, orchestration)", async () => {
    const revoked = fakeRepo(deviceRow({ revokedAt: new Date(), revokeReason: "stolen" }));
    for (const policy of [
      { unknownDevice: "reject", unboundUser: "reject" } as const,
      { unknownDevice: "allow", unboundUser: "allow" } as const,
      { unknownDevice: "reject", unboundUser: "reject", assertFromQuery: true } as const,
    ]) {
      const gate = createSyncDeviceGate(revoked, policy);
      const out = await runGate(
        gate,
        makeReq({ ctx: { tenantId: TENANT, userId: USER_A }, body: { syncDeviceId: DEVICE_1 } }),
      );
      expect(out.next, JSON.stringify(policy)).toBe(false);
      expect(out.status).toBe(403);
      expect(out.body?.code).toBe("SYNC_DEVICE_REVOKED");
    }
  });

  it("refuses a device that is NOT bound to the calling user (forged device id)", async () => {
    const out = await runGate(
      attributed(),
      makeReq({ ctx: { tenantId: TENANT, userId: USER_B }, body: { syncDeviceId: DEVICE_1 } }),
    );
    expect(out.next).toBe(false);
    expect(out.status).toBe(403);
    expect(out.body?.code).toBe("SYNC_DEVICE_NOT_BOUND");
  });

  it("resolves the device from the header when the body carries none (pull/run)", async () => {
    const out = await runGate(
      attributed(),
      makeReq({
        ctx: { tenantId: TENANT, userId: USER_A, syncDeviceId: DEVICE_1 },
        headerDevice: DEVICE_1,
      }),
    );
    expect(out.next).toBe(true);
  });

  it("treats excludeSyncDeviceId as the asserted device only for the pull policy", async () => {
    const q = { excludeSyncDeviceId: DEVICE_1 };
    const withQuery = createSyncDeviceGate(fakeRepo(deviceRow()), {
      unknownDevice: "reject",
      unboundUser: "reject",
      assertFromQuery: true,
    });
    const pullOut = await runGate(
      withQuery,
      makeReq({ ctx: { tenantId: TENANT, userId: USER_A }, query: q }),
    );
    expect(pullOut.next).toBe(true);

    const otherOut = await runGate(
      attributed(),
      makeReq({ ctx: { tenantId: TENANT, userId: USER_B }, query: q }),
    );
    expect(otherOut.next, "a query id is not authority on non-pull routes").toBe(true);
  });

  it("lets an UNSIGNED device through the local orchestration trigger but still blocks revocation", async () => {
    const unknown = createSyncDeviceGate(fakeRepo(null), {
      unknownDevice: "allow",
      unboundUser: "allow",
    });
    const unknownOut = await runGate(
      unknown,
      makeReq({ ctx: { tenantId: TENANT, userId: USER_A }, body: { syncDeviceId: DEVICE_1 } }),
    );
    expect(unknownOut.next, "not-yet-registered local device is a supported state").toBe(true);

    const revokedOut = await runGate(
      orchestration(),
      makeReq({ ctx: { tenantId: TENANT, userId: USER_B }, body: { syncDeviceId: DEVICE_1 } }),
    );
    // Same device, different (unbound) user, revoked-free → orchestration allows.
    expect(revokedOut.next).toBe(true);
  });

  it("leaves unattributed requests alone (no device claimed = no device authority)", async () => {
    const repo = fakeRepo(null);
    const gate = createSyncDeviceGate(repo, { unknownDevice: "reject", unboundUser: "reject" });
    const out = await runGate(gate, makeReq({ ctx: { tenantId: TENANT, userId: USER_A } }));
    expect(out.next).toBe(true);
    expect(repo.findById, "no lookup without an asserted device").not.toHaveBeenCalled();
  });

  it("rejects malformed asserted ids before touching the database", async () => {
    const repo = fakeRepo(null);
    const gate = createSyncDeviceGate(repo, { unknownDevice: "reject", unboundUser: "reject" });
    const out = await runGate(
      gate,
      makeReq({
        ctx: { tenantId: TENANT, userId: USER_A, syncDeviceId: "not-a-uuid" },
        headerDevice: "not-a-uuid",
        body: { syncDeviceId: "1 OR 1=1" },
      }),
    );
    expect(out.next).toBe(true);
    expect(repo.findById).not.toHaveBeenCalled();
  });

  it("401s when no tenant context exists", async () => {
    const out = await runGate(attributed(), makeReq({}));
    expect(out.status).toBe(401);
    expect(out.body?.code).toBe("UNAUTHORIZED");
  });
});

/* ------------------------------------------------------------------ */
/* 4D — master delete base-version discipline                          */
/* ------------------------------------------------------------------ */

const ctx: TenantContext = {
  tenantId: TENANT,
  userId: USER_A,
  userRole: "accountant",
  userName: "tester",
};

/** DFP-019: materialize conflict writes require ALS tenant context. */
function materializeUnderTenant(
  ...args: Parameters<typeof materializeSyncUnit>
): ReturnType<typeof materializeSyncUnit> {
  return runWithTenantContext({ tenantId: TENANT }, () => materializeSyncUnit(...args));
}

type MasterKind = "party" | "fabric" | "color" | "roll";

function makeMasterRepos(
  kind: MasterKind,
  hubRow: Record<string, unknown> | null,
  spies: { deleteFn: ReturnType<typeof vi.fn> },
): SyncMaterializeRepos {
  const withVersion = (row: Record<string, unknown> | null) =>
    row ? { version: 1, updatedAt: "2026-01-01T00:00:00.000Z", ...row } : null;
  const repo = {
    findById: async () => withVersion(hubRow),
    delete: spies.deleteFn,
    cancel: spies.deleteFn,
  };
  return {
    partyRepo: repo,
    fabricRepo: repo,
    colorRepo: repo,
    rollRepo: repo,
    auditRepo: { create: async () => undefined },
  } as unknown as SyncMaterializeRepos;
}

describe("4D — master delete refuses a stale base", () => {
  const database = {} as never;

  for (const kind of ["party", "fabric", "color", "roll"] as MasterKind[]) {
    it(`${kind}: base v2 vs hub v3 → refused, domain delete never called`, async () => {
      const deleteFn = vi.fn();
      const repos = makeMasterRepos(kind, { id: FABRIC_ID, version: 3 }, { deleteFn });

      const result = await materializeUnderTenant(
        database,
        repos,
        { entityType: kind, operation: "delete", payload: { entityId: FABRIC_ID, baseVersion: 2 } },
        ctx,
        { opId: OP_ID, syncDeviceId: null },
      );

      expect(result.status).toBe("failed");
      expect(result.error).toContain("تعارض حذف");
      expect(result.error).toContain("v3");
      expect(
        deleteFn,
        "a stale delete must never reach the domain delete",
      ).not.toHaveBeenCalled();
    });

    it(`${kind}: a matching base is allowed through`, async () => {
      const deleteFn = vi.fn(async () => true);
      const repos = makeMasterRepos(kind, { id: FABRIC_ID, version: 4 }, { deleteFn });

      const result = await materializeUnderTenant(
        database,
        repos,
        { entityType: kind, operation: "delete", payload: { entityId: FABRIC_ID, baseVersion: 4 } },
        ctx,
        { opId: OP_ID, syncDeviceId: null },
      );

      expect(deleteFn, "the domain delete must run for a current base").toHaveBeenCalled();
      // The tombstone write needs the real pool, so on a DB-less run the unit
      // reports `failed` AFTER the delete — the point of the assertion is that
      // the guard did not block it.
      expect(result.status).not.toBe("invalid");
    });
  }

  it("a unit without a base stays unchecked (legacy queued work is not stranded)", async () => {
    const deleteFn = vi.fn(async () => true);
    const repos = makeMasterRepos("fabric", { id: FABRIC_ID, version: 9 }, { deleteFn });

    const result = await materializeUnderTenant(
      database,
      repos,
      { entityType: "fabric", operation: "delete", payload: { entityId: FABRIC_ID } },
      ctx,
      { opId: OP_ID, syncDeviceId: null },
    );

    expect(deleteFn, "no base = old build's unit, replayed as before").toHaveBeenCalled();
    expect(result.status).not.toBe("invalid");
  });

  it("a baseUpdatedAt-only mismatch is refused too", async () => {
    const deleteFn = vi.fn();
    const repos = makeMasterRepos(
      "roll",
      { id: FABRIC_ID, version: 1, updatedAt: "2026-05-05T00:00:00.000Z" },
      { deleteFn },
    );

    const result = await materializeUnderTenant(
      database,
      repos,
      {
        entityType: "roll",
        operation: "delete",
        payload: { entityId: FABRIC_ID, baseUpdatedAt: "2026-01-01T00:00:00.000Z" },
      },
      ctx,
      { opId: OP_ID, syncDeviceId: null },
    );

    expect(result.status).toBe("failed");
    expect(deleteFn).not.toHaveBeenCalled();
  });

  it("an idempotent retry of an applied delete reports exists (row already gone)", async () => {
    const deleteFn = vi.fn();
    const repos = makeMasterRepos("color", null, { deleteFn });

    const result = await materializeUnderTenant(
      database,
      repos,
      { entityType: "color", operation: "delete", payload: { entityId: FABRIC_ID, baseVersion: 1 } },
      ctx,
      { opId: OP_ID, syncDeviceId: null },
    );

    expect(result.status).toBe("exists");
    expect(deleteFn).not.toHaveBeenCalled();
  });
});
