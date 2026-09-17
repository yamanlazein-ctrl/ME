/**
 * Invitation ↔ License link (spec §5.1, §9.1).
 *
 * Hermetic by design: every dependency is a closure fake, so these tests prove
 * the LICENSE BINDING CONTRACT without a database.
 */
import { describe, expect, it } from "vitest";
import {
  consumeInvitationCodeUseCase,
  generateInvitationCodeUseCase,
  validateInvitationCodeUseCase,
} from "@/application/use-cases/invitation/invitationUseCases";
import type { InvitationRow } from "@/application/ports/IInvitationRepository";

const TENANT = "22222222-2222-4222-8222-222222222222";
const LICENSE = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

function invitationRow(over: Partial<InvitationRow> = {}): InvitationRow {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    tenantId: TENANT,
    licenseId: null,
    code: "ABCD-1234-EFGH",
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

function licenseRepoWith(lic: { id: string } | null) {
  return { findLatestForTenant: async () => lic };
}

function fakeInvitationRepo(row: InvitationRow | null) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const calls: { create: any[]; consume: number; createUser: number; registerDevice: any[] } = {
    create: [],
    consume: 0,
    createUser: 0,
    registerDevice: [],
  };
  const repo = {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    create: async (input: any) => {
      calls.create.push(input);
      return {
        ...invitationRow(),
        ...input,
        id: "inv-created",
        useCount: 0,
        revokedAt: null,
        createdAt: new Date(),
      };
    },
    findByCode: async () => row,
    // The use case marks the invitation consumed through `repo` (not the
    // extended repo), mirroring PostgresInvitationRepository.consume.
    consume: async () => {
      calls.consume += 1;
      return { ...row!, useCount: 1 };
    },
  };
  const extended = {
    createUserFromInvitation: async () => {
      calls.createUser += 1;
      return { id: "user-created" };
    },
    registerDevice: async (tenantId: string, licenseId: string, fingerprint: string) => {
      calls.registerDevice.push({ tenantId, licenseId, fingerprint });
      return { id: "dev-created" };
    },
  };
  return { repo, extended, calls };
}

describe("invitation ↔ license link", () => {
  it("generate stamps the tenant license on the invitation row and metadata", async () => {
    const { repo, calls } = fakeInvitationRepo(null);
    const r = await generateInvitationCodeUseCase(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      repo as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      licenseRepoWith({ id: LICENSE }) as any,
      TENANT,
      "creator-1",
      "device",
      {},
    );
    expect(r.ok).toBe(true);
    expect(calls.create).toHaveLength(1);
    expect(calls.create[0].licenseId).toBe(LICENSE);
    expect(calls.create[0].metadata.licenseId).toBe(LICENSE);
  });

  it("generate keeps licenseId null when the tenant has no license yet", async () => {
    const { repo, calls } = fakeInvitationRepo(null);
    const r = await generateInvitationCodeUseCase(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      repo as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      licenseRepoWith(null) as any,
      TENANT,
      "creator-1",
      "user",
      { targetName: "M", targetEmail: "m@t.local", targetRole: "accountant" },
    );
    expect(r.ok).toBe(true);
    expect(calls.create).toHaveLength(1);
    expect(calls.create[0].licenseId).toBeNull();
  });

  it("device redemption with no license anywhere fails closed and writes nothing", async () => {
    const row = invitationRow({ type: "device", licenseId: null });
    const { repo, extended, calls } = fakeInvitationRepo(row);
    const r = await consumeInvitationCodeUseCase(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      repo as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      extended as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      licenseRepoWith(null) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      row.code,
      { deviceFingerprint: "fp-1" },
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("لا يوجد ترخيص");
    expect(calls.registerDevice).toHaveLength(0);
    expect(calls.consume).toBe(0);
    expect(calls.createUser).toBe(0);
  });

  it("device redemption uses the stamped license when the live lookup finds none", async () => {
    const row = invitationRow({ type: "device", licenseId: LICENSE });
    const { repo, extended, calls } = fakeInvitationRepo(row);
    const r = await consumeInvitationCodeUseCase(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      repo as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      extended as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      licenseRepoWith(null) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      row.code,
      { deviceFingerprint: "fp-9" },
    );
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.registeredDeviceId).toBe("dev-created");
    expect(calls.registerDevice).toHaveLength(1);
    expect(calls.registerDevice[0]).toMatchObject({
      tenantId: TENANT,
      licenseId: LICENSE,
      fingerprint: "fp-9",
    });
    expect(calls.consume).toBe(1);
  });

  it("user redemption with a device but no license fails before user creation", async () => {
    const row = invitationRow({
      type: "user",
      licenseId: null,
      metadata: { targetName: "M", targetEmail: "m@t.local", targetRole: "accountant" },
    });
    const { repo, extended, calls } = fakeInvitationRepo(row);
    const r = await consumeInvitationCodeUseCase(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      repo as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      extended as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      licenseRepoWith(null) as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      {} as any,
      row.code,
      { password: "1234", deviceFingerprint: "fp-2" },
    );
    expect(r.ok).toBe(false);
    expect(calls.createUser).toBe(0);
    expect(calls.registerDevice).toHaveLength(0);
    expect(calls.consume).toBe(0);
  });
});

describe("invitation validate states", () => {
  it("unknown code is invalid", async () => {
    const { repo } = fakeInvitationRepo(null);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await validateInvitationCodeUseCase(repo as any, "NOPE-0000-XXXX");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("غير صالح");
  });

  it("revoked code is reported as revoked", async () => {
    const { repo } = fakeInvitationRepo(invitationRow({ revokedAt: new Date() }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await validateInvitationCodeUseCase(repo as any, "ABCD-1234-EFGH");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("إلغاء");
  });

  it("expired code is reported as expired", async () => {
    const { repo } = fakeInvitationRepo(invitationRow({ expiresAt: new Date(Date.now() - 1000) }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await validateInvitationCodeUseCase(repo as any, "ABCD-1234-EFGH");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("انتهت");
  });

  it("already-used code is reported as used", async () => {
    const { repo } = fakeInvitationRepo(invitationRow({ useCount: 1 }));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const r = await validateInvitationCodeUseCase(repo as any, "ABCD-1234-EFGH");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("مسبق");
  });
});