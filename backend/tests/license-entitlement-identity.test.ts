import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { eq } from "drizzle-orm";
import { db, pool } from "../src/infrastructure/orm/drizzle.js";
import { runWithPlatformContext } from "../src/infrastructure/orm/tenant-context.js";
import { licenses } from "../src/infrastructure/orm/schemas/license.table.js";
import { tenants } from "../src/infrastructure/orm/schemas/tenant.table.js";
import { PostgresLicenseRepository } from "../src/infrastructure/repositories/PostgresLicenseRepository.js";
import { PostgresTenantRepository } from "../src/infrastructure/repositories/PostgresTenantRepository.js";
import { detachOrphanBakedLicenses } from "../src/infrastructure/license/detachOrphanBakedLicenses.js";
import { evaluateTenantLicenseAccess } from "../src/infrastructure/license/tenantLicenseAccess.js";
import { syncTenantLicenseCacheFromLicenseRow } from "../src/infrastructure/license/syncTenantLicenseCache.js";
import { createLicenseHeartbeatMiddleware } from "../src/infrastructure/http/middleware/license.heartbeat.middleware.js";
import { createLicenseGuard } from "../src/infrastructure/http/middleware/license.guard.middleware.js";
import { LicenseTokenSigner } from "../src/infrastructure/auth/LicenseTokenSigner.js";
import { AesGcmSecretStore, decodeMasterKey } from "../src/infrastructure/secrets/AesGcmSecretStore.js";
import { PostgresSecretsRepository } from "../src/infrastructure/repositories/PostgresSecretsRepository.js";
import { DbTokenDenylist } from "../src/infrastructure/auth/TokenDenylist.js";
import { config } from "../src/infrastructure/config/env.js";

type MiddlewareResult = {
  statusCode?: number;
  body?: Record<string, unknown>;
  headers: Record<string, string>;
  passed: boolean;
};

async function runMiddleware(
  mw: (req: Request, res: Response, next: NextFunction) => void | Promise<void>,
  req: Request,
): Promise<MiddlewareResult> {
  const headers: Record<string, string> = {};
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(body: Record<string, unknown>) {
        resolve({ statusCode: this.statusCode, body, headers, passed: false });
      },
      setHeader(name: string, value: string) {
        headers[name] = value;
      },
    } as unknown as Response;
    const next = (err?: unknown) => {
      if (err) reject(err);
      else resolve({ statusCode: res.statusCode, headers, passed: true });
    };
    void Promise.resolve(mw(req, res, next)).catch(reject);
  });
}

describe("License entitlement identity — no baked hijack + post-activation gate", () => {
  let tenantId = "";
  let activeLicenseId = "";
  let bakedLicenseId = "";
  let activeKey = "";
  let bakedKey = "";
  let licenseRepo!: PostgresLicenseRepository;
  let tenantRepo!: PostgresTenantRepository;
  let secretsRepo!: PostgresSecretsRepository;
  let signer!: LicenseTokenSigner;
  let cipher!: AesGcmSecretStore;
  let denylist!: DbTokenDenylist;
  const createdIds: string[] = [];

  beforeAll(async () => {
    await pool.query("select 1");
    const masterKey = decodeMasterKey(config.APP_MASTER_KEY);
    if (!masterKey) throw new Error("APP_MASTER_KEY required");

    cipher = new AesGcmSecretStore(masterKey);
    secretsRepo = new PostgresSecretsRepository(cipher, db);
    licenseRepo = new PostgresLicenseRepository(db);
    tenantRepo = new PostgresTenantRepository(db);
    denylist = new DbTokenDenylist();
    const { privateJwk, publicJwk } = await LicenseTokenSigner.generateKeyPair();
    signer = await LicenseTokenSigner.fromJwk(publicJwk, privateJwk);

    const tenant = await pool.query<{ id: string }>(
      `SELECT id::text AS id FROM tenants ORDER BY created_at NULLS LAST LIMIT 1`,
    );
    tenantId = tenant.rows[0]?.id ?? "";
    if (!tenantId) throw new Error("no tenant on test db");

    activeKey = `LIC-ACTIVE-${randomUUID().slice(0, 8).toUpperCase()}`;
    bakedKey = `LIC-BAKED-${randomUUID().slice(0, 8).toUpperCase()}`;

    await runWithPlatformContext(async () => {
      // Stale baked Desktop row bound to the same tenant (older identity).
      const baked = await pool.query<{ id: string }>(
        `INSERT INTO licenses (
           key, type, status, tenant_id, features, grace_days, max_devices,
           edition, plan, license_model, offline_token, offline_token_jti
         ) VALUES (
           $1, 'full', 'active', $2::uuid, ARRAY['erp.core']::text[], 7, 1,
           'desktop', 'standard', 'perpetual', 'stale.baked.jwt', $3
         ) RETURNING id::text AS id`,
        [bakedKey, tenantId, randomUUID()],
      );
      bakedLicenseId = baked.rows[0]!.id;
      createdIds.push(bakedLicenseId);

      // Real dashboard-issued entitlement (current).
      const active = await pool.query<{ id: string }>(
        `INSERT INTO licenses (
           key, type, status, tenant_id, features, grace_days, max_devices,
           edition, plan, license_model
         ) VALUES (
           $1, 'full', 'active', $2::uuid, ARRAY['erp.core']::text[], 7, 5,
           'erp', 'enterprise', 'perpetual'
         ) RETURNING id::text AS id`,
        [activeKey, tenantId],
      );
      activeLicenseId = active.rows[0]!.id;
      createdIds.push(activeLicenseId);

      await pool.query(
        `UPDATE tenants SET license_key = $1, license_status = 'active',
         activation_id = NULL, updated_at = now() WHERE id = $2::uuid`,
        [activeKey, tenantId],
      );
    });
  });

  afterAll(async () => {
    await runWithPlatformContext(async () => {
      for (const id of createdIds) {
        await pool.query(`DELETE FROM licenses WHERE id = $1::uuid`, [id]);
      }
      // Restore tenant pointer if we clobbered a shared fixture tenant — leave
      // license_key null only when it still points at our deleted key.
      await pool.query(
        `UPDATE tenants SET license_key = NULLIF(license_key, $1), updated_at = now()
         WHERE id = $2::uuid AND license_key = $1`,
        [activeKey, tenantId],
      );
    });
  });

  it("findLatestForTenant resolves tenants.license_key, not newest/baked row", async () => {
    const lic = await licenseRepo.findLatestForTenant(tenantId as never);
    expect(lic?.id).toBe(activeLicenseId);
    expect(lic?.key).toBe(activeKey);
    expect(lic?.id).not.toBe(bakedLicenseId);
  });

  it("findBakedForTenant returns null when tenant key is a non-baked entitlement", async () => {
    const baked = await licenseRepo.findBakedForTenant(tenantId as never);
    expect(baked).toBeNull();
  });

  it("detachOrphanBakedLicenses clears tenant_id on stale bake without deleting it", async () => {
    const n = await detachOrphanBakedLicenses(db);
    expect(n).toBeGreaterThanOrEqual(1);

    const [row] = await runWithPlatformContext(async () =>
      db.select().from(licenses).where(eq(licenses.id, bakedLicenseId as never)).limit(1),
    );
    expect(row?.tenantId).toBeNull();
    expect(row?.key).toBe(bakedKey);
    expect(row?.offlineToken).toBeTruthy();

    // Active entitlement unchanged
    const active = await licenseRepo.findLatestForTenant(tenantId as never);
    expect(active?.id).toBe(activeLicenseId);
  });

  it("syncTenantLicenseCache ignores mutations on non-current license key", async () => {
    // Re-bind baked briefly to simulate vendor patch on wrong row
    await runWithPlatformContext(async () => {
      await db
        .update(licenses)
        .set({ tenantId: tenantId as never, status: "suspended", updatedAt: new Date() })
        .where(eq(licenses.id, bakedLicenseId as never));
    });

    const [bakedRow] = await runWithPlatformContext(async () =>
      db.select().from(licenses).where(eq(licenses.id, bakedLicenseId as never)).limit(1),
    );
    const synced = await syncTenantLicenseCacheFromLicenseRow(db, bakedRow as never);
    expect(synced).toBe(false);

    const [tenant] = await runWithPlatformContext(async () =>
      db.select().from(tenants).where(eq(tenants.id, tenantId as never)).limit(1),
    );
    expect(tenant?.licenseKey).toBe(activeKey);
    expect(tenant?.licenseStatus).toBe("active");

    // cleanup re-detach
    await detachOrphanBakedLicenses(db);
  });

  it("evaluateTenantLicenseAccess blocks suspended even when PIN/password exist", async () => {
    await runWithPlatformContext(async () => {
      await db
        .update(licenses)
        .set({ status: "suspended", updatedAt: new Date() })
        .where(eq(licenses.id, activeLicenseId as never));
    });

    const denied = await evaluateTenantLicenseAccess({
      licenseRepo,
      tenantRepo,
      tenantId,
    });
    expect(denied.ok).toBe(false);
    if (!denied.ok) expect(denied.code).toBe("LICENSE_SUSPENDED");

    await runWithPlatformContext(async () => {
      await db
        .update(licenses)
        .set({ status: "active", updatedAt: new Date() })
        .where(eq(licenses.id, activeLicenseId as never));
    });

    const ok = await evaluateTenantLicenseAccess({
      licenseRepo,
      tenantRepo,
      tenantId,
    });
    expect(ok.ok).toBe(true);
  });

  it("heartbeat+guard block missing entitlement after activation pointer set", async () => {
    // Point tenant at a non-existent key → findLatest null + activated → missing
    await runWithPlatformContext(async () => {
      await pool.query(
        `UPDATE tenants SET license_key = $1 WHERE id = $2::uuid`,
        [`LIC-MISSING-${randomUUID().slice(0, 8)}`, tenantId],
      );
    });

    const heartbeat = createLicenseHeartbeatMiddleware(
      licenseRepo,
      secretsRepo,
      cipher,
      signer,
      tenantRepo,
    );
    const guard = createLicenseGuard({
      licenseRepo,
      secretsRepo,
      signer,
      cipher,
      tokenDenylist: denylist,
    });

    const req = {
      tenantContext: { tenantId, userId: randomUUID(), role: "admin" },
    } as unknown as Request;

    await runMiddleware(heartbeat, req);
    expect(req.license?.status).toBe("missing");

    const blocked = await runMiddleware(guard, req);
    expect(blocked.passed).toBe(false);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.body?.code).toBe("LICENSE_REQUIRED");

    // restore
    await runWithPlatformContext(async () => {
      await pool.query(
        `UPDATE tenants SET license_key = $1, license_status = 'active' WHERE id = $2::uuid`,
        [activeKey, tenantId],
      );
      await db
        .update(licenses)
        .set({ status: "active", updatedAt: new Date() })
        .where(eq(licenses.id, activeLicenseId as never));
    });
  });

  it("does not overwrite user password_hash or pin_hash when suspending license", async () => {
    const before = await pool.query<{
      password_hash: string;
      pin_hash: string | null;
    }>(
      `SELECT password_hash, pin_hash FROM users WHERE tenant_id = $1::uuid LIMIT 1`,
      [tenantId],
    );
    if (before.rowCount === 0) return; // no users on fixture — skip

    const snap = before.rows[0]!;

    await runWithPlatformContext(async () => {
      await db
        .update(licenses)
        .set({ status: "suspended", updatedAt: new Date() })
        .where(eq(licenses.id, activeLicenseId as never));
      const [row] = await db.select().from(licenses).where(eq(licenses.id, activeLicenseId as never));
      await syncTenantLicenseCacheFromLicenseRow(db, row as never);
    });

    const after = await pool.query<{
      password_hash: string;
      pin_hash: string | null;
    }>(
      `SELECT password_hash, pin_hash FROM users WHERE tenant_id = $1::uuid LIMIT 1`,
      [tenantId],
    );
    expect(after.rows[0]?.password_hash).toBe(snap.password_hash);
    expect(after.rows[0]?.pin_hash).toBe(snap.pin_hash);

    await runWithPlatformContext(async () => {
      await db
        .update(licenses)
        .set({ status: "active", updatedAt: new Date() })
        .where(eq(licenses.id, activeLicenseId as never));
      const [row] = await db.select().from(licenses).where(eq(licenses.id, activeLicenseId as never));
      await syncTenantLicenseCacheFromLicenseRow(db, row as never);
    });
  });
});
