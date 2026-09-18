/**
 * DFP-005 / DFP-006 — live PostgreSQL proofs:
 *  1) Mid-transaction failure leaves zero device/user side effects and invitation use_count=0.
 *  2) Parallel device redeem with maxDevices=1 yields exactly one device.
 *
 * Requires DATABASE_URL pointing at a migrated database (bundled desktop PG is fine).
 */
import { describe, it, expect, beforeAll } from "vitest";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";
import { db } from "@/infrastructure/orm/drizzle.js";
import { tenants } from "@/infrastructure/orm/schemas/tenant.table.js";
import { users } from "@/infrastructure/orm/schemas/user.table.js";
import { licenses } from "@/infrastructure/orm/schemas/license.table.js";
import { invitationCodes } from "@/infrastructure/orm/schemas/invitation-code.table.js";
import { deviceRegistrations } from "@/infrastructure/orm/schemas/device-registration.table.js";
import { PostgresInvitationRepository } from "@/infrastructure/repositories/PostgresInvitationRepository.js";
import { PostgresLicenseRepository } from "@/infrastructure/repositories/PostgresLicenseRepository.js";
import { Argon2PasswordHasher } from "@/infrastructure/auth/PasswordHasher.js";
import { consumeInvitationCodeUseCase } from "@/application/use-cases/invitation/invitationUseCases.js";
import { runWithPlatformContext } from "@/infrastructure/orm/tenant-context.js";
import { eq, count, inArray, and } from "drizzle-orm";

const LIVE = Boolean(process.env.DATABASE_URL || process.env.TEST_DB_URL);

async function seedTenantLicense(opts: { maxDevices: number; codeSuffix: string }) {
  const tenantId = randomUUID();
  const licenseId = randomUUID();
  const adminId = randomUUID();
  const code = `LIVE-${opts.codeSuffix}-${randomUUID().slice(0, 6).toUpperCase()}`;

  await runWithPlatformContext(async () => {
    await db.insert(tenants).values({
      id: tenantId,
      name: `DFP Live ${opts.codeSuffix}`,
      slug: `dfp-${opts.codeSuffix}-${tenantId.slice(0, 8)}`,
    });
    await db.insert(licenses).values({
      id: licenseId,
      tenantId,
      key: `KEY-${licenseId.slice(0, 12)}`,
      type: "full",
      status: "active",
      maxDevices: opts.maxDevices,
      limits: { users: 10, devices: opts.maxDevices },
      features: [],
    });
    await db.insert(users).values({
      id: adminId,
      tenantId,
      name: "Live Admin",
      email: `live-admin-${adminId.slice(0, 8)}@test.local`,
      passwordHash: "x",
      role: "admin",
      active: true,
    });
    await db.insert(invitationCodes).values({
      id: randomUUID(),
      tenantId,
      licenseId,
      code,
      type: "device",
      expiresAt: new Date(Date.now() + 3600_000),
      useCount: 0,
      metadata: {},
      createdBy: adminId,
    });
  });

  return { tenantId, licenseId, code };
}

async function countDevices(tenantId: string): Promise<number> {
  return runWithPlatformContext(async () => {
    const [{ c }] = await db
      .select({ c: count() })
      .from(deviceRegistrations)
      .where(eq(deviceRegistrations.tenantId, tenantId));
    return Number(c);
  });
}

async function invitationUseCount(code: string): Promise<number> {
  return runWithPlatformContext(async () => {
    const [row] = await db
      .select({ useCount: invitationCodes.useCount })
      .from(invitationCodes)
      .where(eq(invitationCodes.code, code))
      .limit(1);
    return row?.useCount ?? -1;
  });
}

describe.skipIf(!LIVE)("DFP-005/006 invitation live PG", () => {
  beforeAll(async () => {
    // Sanity: DB reachable
    await db.execute(sql`SELECT 1`);
  });

  it("rolls back device insert when consume throws mid-transaction (DFP-005)", async () => {
    const { tenantId, code } = await seedTenantLicense({ maxDevices: 5, codeSuffix: "rb" });
    const repo = new PostgresInvitationRepository();
    const licenseRepo = new PostgresLicenseRepository();
    const hasher = new Argon2PasswordHasher();

    const origRegister = repo.registerDevice.bind(repo);
    repo.registerDevice = async (...args: Parameters<typeof origRegister>) => {
      await origRegister(...args);
      throw new Error("INJECTED_AFTER_DEVICE");
    };

    const result = await consumeInvitationCodeUseCase(
      repo,
      repo,
      licenseRepo,
      hasher,
      code,
      { deviceFingerprint: `fp-rb-${randomUUID()}` },
    );

    expect(result.ok).toBe(false);
    expect(await countDevices(tenantId)).toBe(0);
    expect(await invitationUseCount(code)).toBe(0);
  });

  it("parallel redeem with maxDevices=1 allows exactly one device (DFP-006)", async () => {
    const { tenantId, licenseId, code } = await seedTenantLicense({
      maxDevices: 1,
      codeSuffix: "race",
    });
    // Two invitations sharing the same seat pool: first invitation + a second code
    const code2 = `LIVE-R2-${randomUUID().slice(0, 6).toUpperCase()}`;
    await runWithPlatformContext(async () => {
      const [admin] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.tenantId, tenantId))
        .limit(1);
      await db.insert(invitationCodes).values({
        id: randomUUID(),
        tenantId,
        licenseId,
        code: code2,
        type: "device",
        expiresAt: new Date(Date.now() + 3600_000),
        useCount: 0,
        metadata: {},
        createdBy: admin!.id,
      });
    });

    const makeConsume = (fp: string, invCode: string) => {
      const repo = new PostgresInvitationRepository();
      const licenseRepo = new PostgresLicenseRepository();
      const hasher = new Argon2PasswordHasher();
      return consumeInvitationCodeUseCase(repo, repo, licenseRepo, hasher, invCode, {
        deviceFingerprint: fp,
      });
    };

    const [a, b] = await Promise.all([
      makeConsume(`fp-a-${randomUUID()}`, code),
      makeConsume(`fp-b-${randomUUID()}`, code2),
    ]);

    const oks = [a, b].filter((r) => r.ok).length;
    const fails = [a, b].filter((r) => !r.ok).length;
    expect(oks).toBe(1);
    expect(fails).toBe(1);
    expect(await countDevices(tenantId)).toBe(1);

    const used = await runWithPlatformContext(async () => {
      return db
        .select({ code: invitationCodes.code, useCount: invitationCodes.useCount })
        .from(invitationCodes)
        .where(
          and(
            eq(invitationCodes.tenantId, tenantId),
            inArray(invitationCodes.code, [code, code2]),
          ),
        );
    });
    const consumed = used.filter((r) => r.useCount === 1).length;
    const leftover = used.filter((r) => r.useCount === 0).length;
    expect(consumed).toBe(1);
    expect(leftover).toBe(1);
  });
});
