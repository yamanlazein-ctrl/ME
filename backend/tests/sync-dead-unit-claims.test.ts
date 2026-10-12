/**
 * S-04: a unit the hub parks as `dead` (permanently invalid, or out of apply attempts) will never be
 * retried — so its stock claims can never serve a future apply. They used to stay held until an
 * operator ran the manual reap, and every later sale of that roll from any device got a 409.
 *
 * Fakes only (no database): the claim/inbox contracts are what is under test.
 */
import { describe, it, expect } from "vitest";
import { randomUUID } from "node:crypto";
import {
  receiveSyncPush,
  MATERIALIZE_MAX_ATTEMPTS,
} from "@/application/use-cases/sync/syncUseCases.js";

function harness(applyAttemptsAfterFailure: number) {
  const tenantId = randomUUID();
  const opId = randomUUID();
  const row = {
    tenantId,
    opId,
    syncDeviceId: null,
    entityType: "print",
    entityId: randomUUID(),
    operation: "send",
    payload: {} as Record<string, unknown>,
    status: "received",
    applyAttempts: 0,
  };
  const released: string[] = [];
  const inbox = {
    receive: async (i: { payload: Record<string, unknown> }) => {
      row.payload = i.payload;
      return { created: true, row };
    },
    findByOpId: async () => row,
    markApplied: async () => {
      row.status = "applied";
    },
    markDead: async () => {
      row.status = "dead";
    },
    markRejected: async () => {
      row.status = "rejected";
      return row;
    },
    setMaterializeError: async () => ({ ...row, applyAttempts: applyAttemptsAfterFailure }),
  };
  const claims = {
    tryClaimAll: async () => ({ ok: true }),
    releaseByOp: async (_t: string, op: string) => {
      released.push(op);
      return 1;
    },
    releaseByEntity: async () => 0,
  };
  return { tenantId, opId, row, released, inbox, claims };
}

const push = (
  h: ReturnType<typeof harness>,
  payload: Record<string, unknown>,
  repos: Record<string, unknown>,
) =>
  receiveSyncPush(h.inbox as never, h.claims as never, {} as never, repos as never, {} as never, {
    tenantId: h.tenantId,
    opId: h.opId,
    entityType: "print",
    entityId: h.row.entityId,
    operation: "send",
    payload,
    hubCtx: { tenantId: h.tenantId, userId: randomUUID(), userRole: "admin" } as never,
  });

describe("claims of a dead sync unit are released (S-04)", () => {
  it("permanently invalid unit → dead → its roll claim is released", async () => {
    const h = harness(1);
    // Claims the roll (sourceRollId) but carries no jobId: materialize answers `invalid`.
    await push(
      h,
      { sendInput: { sourceRollId: randomUUID(), quantityKg: 2 } },
      { printJobRepo: {} },
    );
    expect(h.row.status).toBe("dead");
    expect(h.released).toContain(h.opId);
  });

  it("unit that exhausts its apply attempts → dead → its roll claim is released", async () => {
    const h = harness(MATERIALIZE_MAX_ATTEMPTS);
    // No print repo wired: a retryable failure, here on the last allowed attempt.
    await push(
      h,
      { jobId: randomUUID(), sendInput: { sourceRollId: randomUUID(), quantityKg: 2 } },
      {},
    );
    expect(h.row.status).toBe("dead");
    expect(h.released).toContain(h.opId);
  });

  it("a unit still retrying (received) keeps its claim", async () => {
    const h = harness(1);
    await push(
      h,
      { jobId: randomUUID(), sendInput: { sourceRollId: randomUUID(), quantityKg: 2 } },
      {},
    );
    expect(h.row.status).toBe("received");
    expect(h.released).toEqual([]);
  });
});
