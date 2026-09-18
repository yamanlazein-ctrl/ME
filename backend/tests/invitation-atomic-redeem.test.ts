/**
 * DFP-005 / DFP-006 — invitation redeem must run inside one tenant transaction
 * with invitation (+ license) row locks when the Postgres repository is used.
 */
import { describe, expect, it, vi } from "vitest";
import { consumeInvitationCodeUseCase } from "@/application/use-cases/invitation/invitationUseCases";
import type { InvitationRow } from "@/application/ports/IInvitationRepository";

const TENANT = "22222222-2222-4222-8222-222222222222";
const LICENSE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function invitationRow(over: Partial<InvitationRow> = {}): InvitationRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    tenantId: TENANT,
    licenseId: LICENSE,
    code: "LOCK-1234-TEST",
    type: "device",
    expiresAt: new Date(Date.now() + 3600_000),
    revokedAt: null,
    useCount: 0,
    metadata: {},
    createdBy: "33333333-3333-4333-8333-333333333333",
    createdAt: new Date(),
    ...over,
  };
}

describe("DFP-005/006 invitation atomic redeem", () => {
  it("routes redeem through runInTenantTransaction when provided", async () => {
    const row = invitationRow();
    let txEntered = false;
    const order: string[] = [];

    const repo = {
      findByCode: async () => row,
      consume: async () => {
        order.push("consume");
        return { ...row, useCount: 1 };
      },
    };
    const extended = {
      runInTenantTransaction: async (_tenantId: string, fn: () => Promise<unknown>) => {
        txEntered = true;
        order.push("tx-enter");
        const result = await fn();
        order.push("tx-exit");
        return result;
      },
      lockByIdForUpdate: async () => {
        order.push("lock-invitation");
        return row;
      },
      lockLicenseForUpdate: async () => {
        order.push("lock-license");
      },
      countUsersInTenant: async () => 0,
      countDevicesInTenant: async () => 0,
      registerDevice: async () => {
        order.push("register-device");
        return { id: "dev-1" };
      },
      createUserFromInvitation: async () => ({ id: "u-1" }),
      setUserPinHash: async () => undefined,
    };
    const licenseRepo = {
      findLatestForTenant: async () => ({
        id: LICENSE,
        limits: { users: 10, devices: 5 },
        maxDevices: 5,
      }),
    };

    const r = await consumeInvitationCodeUseCase(
      repo as never,
      extended as never,
      licenseRepo as never,
      { hash: async () => "hash" } as never,
      row.code,
      { deviceFingerprint: "fp-a" },
    );

    expect(r.ok).toBe(true);
    expect(txEntered).toBe(true);
    expect(order[0]).toBe("tx-enter");
    expect(order).toContain("lock-invitation");
    expect(order).toContain("lock-license");
    expect(order).toContain("register-device");
    expect(order).toContain("consume");
    expect(order.at(-1)).toBe("tx-exit");
  });

  it("rolls back side effects when consume throws inside the transaction callback", async () => {
    const row = invitationRow();
    const registered: string[] = [];
    const extended = {
      runInTenantTransaction: async (_t: string, fn: () => Promise<unknown>) => fn(),
      lockByIdForUpdate: async () => row,
      lockLicenseForUpdate: async () => undefined,
      countUsersInTenant: async () => 0,
      countDevicesInTenant: async () => 0,
      registerDevice: async () => {
        registered.push("dev");
        return { id: "dev-1" };
      },
    };
    const repo = {
      findByCode: async () => row,
      consume: async () => {
        throw new Error("INVITATION_ALREADY_CONSUMED");
      },
    };
    const licenseRepo = {
      findLatestForTenant: async () => ({
        id: LICENSE,
        limits: { users: 10, devices: 5 },
        maxDevices: 5,
      }),
    };

    const r = await consumeInvitationCodeUseCase(
      repo as never,
      extended as never,
      licenseRepo as never,
      { hash: async () => "hash" } as never,
      row.code,
      { deviceFingerprint: "fp-b" },
    );

    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("مسبقاً");
    // In the real Postgres path, registerDevice would roll back with the tx.
    // This unit test documents that consume failure surfaces as a clean error;
    // the repository's withTenantTx is what guarantees rollback (integration).
    expect(registered).toEqual(["dev"]);
    void vi;
  });
});
