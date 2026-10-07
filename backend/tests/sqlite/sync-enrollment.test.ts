/**
 * Device enrollment on the hub: one company code serves several devices up to
 * the license's device limit; each device gets its own id + credential, trades
 * the credential for tokens, and loses that the moment an admin disables it.
 * Own temporary data root; runs on either suite.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { sql } from "drizzle-orm";

const root = mkdtempSync(join(tmpdir(), "motard-enroll-"));
process.env.DB_ENGINE = "sqlite";
process.env.SQLITE_PATH = join(root, "data", "motard.db");
process.env.MOTARD_STARTUP_STATE = "FRESH";
delete process.env.DATABASE_URL;
delete process.env.DESKTOP_SEED_PATH;

const tenantId = randomUUID();
const adminId = randomUUID();
let tx: typeof import("@/infrastructure/orm/sqlite/transaction.js");
let runtime: typeof import("@/infrastructure/orm/sqlite/runtime.js");
let en: typeof import("@/application/use-cases/sync/syncEnrollment.js");
let deps: import("@/application/use-cases/sync/syncEnrollment.js").EnrollmentDeps;

const device = (fp: string) => ({ id: randomUUID(), fingerprint: `fp-${fp}-0123456789`, platform: "windows", hostname: fp });

beforeAll(async () => {
  runtime = await import("@/infrastructure/orm/sqlite/runtime.js");
  tx = await import("@/infrastructure/orm/sqlite/transaction.js");
  await runtime.ensureSqliteRuntime();
  await tx.runInTransaction(async (t) => {
    await t.execute(sql`INSERT INTO tenants (id, name, slug) VALUES (${tenantId}, 'Hub Co', 'hubco')`);
    await t.execute(sql`INSERT INTO users (id, tenant_id, name, email, password_hash, role)
                        VALUES (${adminId}, ${tenantId}, 'مدير المركز', 'admin@hub.test', 'x', 'admin')`);
    await t.execute(sql`INSERT INTO licenses (id, key, type, status, plan, edition, tenant_id, customer_name, max_devices, limits)
                        VALUES (${randomUUID()}, 'LIC-HUB-0001', 'full', 'active', 'standard', 'enterprise', ${tenantId}, 'Hub Co', 2, '{"devices":2}')`);
  });
  en = await import("@/application/use-cases/sync/syncEnrollment.js");
  const db = tx.sqliteIndependentDb() as never;
  const { AesGcmSecretStore, decodeMasterKey } = await import("@/infrastructure/secrets/AesGcmSecretStore.js");
  const { SqliteSecretsRepository } = await import("@/infrastructure/repositories/sqlite/SqliteSecretsRepository.js");
  const { SqliteSyncDeviceRepository } = await import("@/infrastructure/repositories/sqlite/SqliteSyncDeviceRepository.js");
  const { SqliteLicenseRepository } = await import("@/infrastructure/repositories/sqlite/SqliteLicenseRepository.js");
  const { SqliteTenantRepository } = await import("@/infrastructure/repositories/sqlite/SqliteTenantRepository.js");
  const { JwtSigner } = await import("@/infrastructure/auth/JwtSigner.js");
  const cipher = new AesGcmSecretStore(decodeMasterKey(process.env.APP_MASTER_KEY!)!);
  deps = {
    secretCipher: cipher,
    secretsRepo: new SqliteSecretsRepository(cipher, db),
    syncDeviceRepo: new SqliteSyncDeviceRepository(db),
    licenseRepo: new SqliteLicenseRepository(db),
    tenantRepo: new SqliteTenantRepository(db),
    jwtSigner: new JwtSigner(),
  };
}, 60_000);

afterAll(() => {
  runtime?.shutdownSqliteRuntime();
  rmSync(root, { recursive: true, force: true });
});

describe("hub device enrollment", () => {
  it("one code enrolls several devices within the license limit, each with its own identity", async () => {
    const issued = await en.createEnrollmentCode(deps, tenantId, adminId, { maxUses: 10 });
    expect(issued.code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);

    const a = device("a");
    const ra = await en.redeemEnrollmentCode(deps, tenantId, issued.code.toLowerCase().replace(/-/g, " "), a);
    expect(ra.ok).toBe(true);
    if (!ra.ok) return;
    expect(ra.deviceId).toBe(a.id); // pushes carry the LOCAL id, so the hub must use it
    expect(ra.deviceSecret.length).toBeGreaterThan(30);
    const claims = await deps.jwtSigner.verifyAccessToken(ra.accessToken);
    expect(claims).toMatchObject({ sub: adminId, tenantId, role: "admin" });
    const row = await deps.syncDeviceRepo.findById(tenantId as never, a.id as never);
    expect(row?.authorizedUserIds).toContain(adminId); // passes the hub's device gate

    const b = device("b");
    expect((await en.redeemEnrollmentCode(deps, tenantId, issued.code, b)).ok).toBe(true);
    // re-enrolling an existing device does not take another seat
    expect((await en.redeemEnrollmentCode(deps, tenantId, issued.code, a)).ok).toBe(true);
    const c = await en.redeemEnrollmentCode(deps, tenantId, issued.code, device("c"));
    expect(c).toMatchObject({ ok: false, code: "DEVICE_LIMIT" });
    expect((await en.getEnrollmentCode(deps, tenantId))?.uses).toBe(3);
  });

  it("the device credential yields tokens until the device is disabled, and again after re-enable", async () => {
    const { code } = await en.createEnrollmentCode(deps, tenantId, adminId);
    const d = device("cred");
    await deps.syncDeviceRepo.setRevoked(tenantId as never, (await deps.syncDeviceRepo.listForTenant(tenantId as never))[0].id, true, "free a seat");
    const r = await en.redeemEnrollmentCode(deps, tenantId, code, d);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const ok = await en.exchangeDeviceToken(deps, tenantId, d.id, r.deviceSecret);
    expect(ok.ok).toBe(true);
    expect(await en.exchangeDeviceToken(deps, tenantId, d.id, "x".repeat(43))).toMatchObject({ ok: false, status: 401 });

    await deps.syncDeviceRepo.setRevoked(tenantId as never, d.id as never, true, "lost laptop");
    expect(await en.exchangeDeviceToken(deps, tenantId, d.id, r.deviceSecret)).toMatchObject({ ok: false, code: "SYNC_DEVICE_REVOKED" });
    // a disabled device cannot sneak back in with the code either
    expect(await en.redeemEnrollmentCode(deps, tenantId, code, d)).toMatchObject({ ok: false, code: "SYNC_DEVICE_REVOKED" });

    await deps.syncDeviceRepo.setRevoked(tenantId as never, d.id as never, false, null);
    expect((await en.exchangeDeviceToken(deps, tenantId, d.id, r.deviceSecret)).ok).toBe(true);
  });

  it("the same PC under a new id (reinstall/restore) re-enrolls only after disable + a NEW code", async () => {
    for (const d of await deps.syncDeviceRepo.listForTenant(tenantId as never)) {
      if (!d.revokedAt) await deps.syncDeviceRepo.setRevoked(tenantId as never, d.id as never, true, "free seats");
    }
    const old = device("same-pc");
    const first = await en.createEnrollmentCode(deps, tenantId, adminId);
    expect((await en.redeemEnrollmentCode(deps, tenantId, first.code, old)).ok).toBe(true);
    const fresh = { ...old, id: randomUUID() };
    // old row still active: the admin must disable it first
    expect(await en.redeemEnrollmentCode(deps, tenantId, first.code, fresh)).toMatchObject({ ok: false, code: "SYNC_DEVICE_ID_CONFLICT" });
    await deps.syncDeviceRepo.setRevoked(tenantId as never, old.id as never, true, "reinstalled");
    // a code the machine already knew does not let it back in
    expect(await en.redeemEnrollmentCode(deps, tenantId, first.code, fresh)).toMatchObject({ ok: false, code: "SYNC_DEVICE_REVOKED" });
    await new Promise((r) => setTimeout(r, 5));
    const second = await en.createEnrollmentCode(deps, tenantId, adminId);
    const r = await en.redeemEnrollmentCode(deps, tenantId, second.code, fresh);
    expect(r).toMatchObject({ ok: true, deviceId: fresh.id });
    const kept = await deps.syncDeviceRepo.findById(tenantId as never, old.id as never);
    expect(kept?.revokedAt).not.toBeNull(); // history kept, still disabled
    expect(kept?.deviceFingerprint).toContain("#retired:");
  });

  it("a wrong, replaced, cancelled, used-up or expired code is refused", async () => {
    const first = await en.createEnrollmentCode(deps, tenantId, adminId);
    await en.createEnrollmentCode(deps, tenantId, adminId); // replaces the first
    expect(await en.redeemEnrollmentCode(deps, tenantId, first.code, device("x"))).toMatchObject({ ok: false, code: "ENROLL_CODE_INVALID" });

    const one = await en.createEnrollmentCode(deps, tenantId, adminId, { maxUses: 1 });
    const known = (await deps.syncDeviceRepo.listForTenant(tenantId as never)).find((r) => !r.revokedAt)!;
    const again = { id: known.id, fingerprint: known.deviceFingerprint, platform: "windows" };
    expect((await en.redeemEnrollmentCode(deps, tenantId, one.code, again)).ok).toBe(true);
    expect(await en.redeemEnrollmentCode(deps, tenantId, one.code, again)).toMatchObject({ ok: false, code: "ENROLL_CODE_USED_UP" });

    const gone = await en.createEnrollmentCode(deps, tenantId, adminId);
    await en.revokeEnrollmentCode(deps, tenantId);
    expect(await en.redeemEnrollmentCode(deps, tenantId, gone.code, again)).toMatchObject({ ok: false, code: "ENROLL_CODE_INVALID" });

    const old = await en.createEnrollmentCode(deps, tenantId, adminId, { ttlHours: -1 });
    expect(await en.redeemEnrollmentCode(deps, tenantId, old.code, again)).toMatchObject({ ok: false, code: "ENROLL_CODE_EXPIRED" });
  });
});
