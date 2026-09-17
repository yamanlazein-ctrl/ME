import { describe, expect, it, beforeAll, afterAll } from "vitest";
import { randomUUID } from "node:crypto";
import { eq, inArray } from "drizzle-orm";
import type { Request, Response, NextFunction } from "express";
import { db, pool } from "../src/infrastructure/orm/drizzle.js";
import { runWithPlatformContext } from "../src/infrastructure/orm/tenant-context.js";
import { licenses } from "../src/infrastructure/orm/schemas/license.table.js";
import { revokedTokens } from "../src/infrastructure/orm/schemas/revoked-token.table.js";
import { LicenseTokenSigner } from "../src/infrastructure/auth/LicenseTokenSigner.js";
import { DbTokenDenylist } from "../src/infrastructure/auth/TokenDenylist.js";
import { AesGcmSecretStore, decodeMasterKey } from "../src/infrastructure/secrets/AesGcmSecretStore.js";
import { PostgresSecretsRepository } from "../src/infrastructure/repositories/PostgresSecretsRepository.js";
import { PostgresLicenseRepository } from "../src/infrastructure/repositories/PostgresLicenseRepository.js";
import { createLicenseHeartbeatMiddleware } from "../src/infrastructure/http/middleware/license.heartbeat.middleware.js";
import { createLicenseGuard } from "../src/infrastructure/http/middleware/license.guard.middleware.js";
import { refreshOfflineEntitlement } from "../src/infrastructure/license/refreshOfflineEntitlement.js";
import { collectOfflineTokenJtisForDenylist } from "../src/infrastructure/license/licenseTokenJti.js";
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

describe("Phase 8 — entitlement enforcement (live postgres)", () => {
  let tenantId = "";
  let licenseId = "";
  let createdLicense = false;
  let signer!: LicenseTokenSigner;
  let secretsRepo!: PostgresSecretsRepository;
  let licenseRepo!: PostgresLicenseRepository;
  let denylist!: DbTokenDenylist;
  let cipher!: AesGcmSecretStore;

  const denylistedJtis: string[] = [];

  beforeAll(async () => {
    await pool.query("select 1");

    const masterKey = decodeMasterKey(config.APP_MASTER_KEY);
    if (!masterKey) throw new Error("APP_MASTER_KEY required for Phase 8 integration tests");

    cipher = new AesGcmSecretStore(masterKey);
    secretsRepo = new PostgresSecretsRepository(cipher, db);
    licenseRepo = new PostgresLicenseRepository(db);
    denylist = new DbTokenDenylist();

    const { privateJwk, publicJwk } = await LicenseTokenSigner.generateKeyPair();
    signer = await LicenseTokenSigner.fromJwk(publicJwk, privateJwk);

    const tenant = await pool.query<{ id: string }>(
      `SELECT id::text AS id FROM tenants ORDER BY created_at NULLS LAST LIMIT 1`,
    );
    tenantId = tenant.rows[0]?.id ?? "";
    if (!tenantId) throw new Error("no tenant on erp_test — cannot run Phase 8 integration");

    // Self-contained fixture: never mutate an ambient production-like license row.
    const key = `P8-TEST-${randomUUID().slice(0, 8)}`;
    const inserted = await runWithPlatformContext(async () =>
      pool.query<{ id: string }>(
        `INSERT INTO licenses (
           key, type, status, tenant_id, features, grace_days, max_devices,
           edition, plan, license_model
         ) VALUES (
           $1, 'full', 'active', $2::uuid, ARRAY['erp.core']::text[], 7, 3,
           'standard', 'pro', 'perpetual'
         )
         RETURNING id::text AS id`,
        [key, tenantId],
      ),
    );
    licenseId = inserted.rows[0]?.id ?? "";
    if (!licenseId) throw new Error("failed to insert Phase 8 test license");
    createdLicense = true;

    // Pin entitlement pointer so findLatestForTenant cannot resolve a
    // co-located baked/ambient license on the shared fixture tenant.
    await runWithPlatformContext(async () => {
      await pool.query(
        `UPDATE tenants SET license_key = $1, license_status = 'active', updated_at = now()
         WHERE id = $2::uuid`,
        [key, tenantId],
      );
    });
  });

  afterAll(async () => {
    if (createdLicense && licenseId) {
      await runWithPlatformContext(async () => {
        await pool.query(
          `UPDATE tenants SET license_key = NULLIF(license_key, (
             SELECT key FROM licenses WHERE id = $1::uuid
           )), updated_at = now()
           WHERE id = $2::uuid`,
          [licenseId, tenantId],
        );
        await pool.query(`DELETE FROM licenses WHERE id = $1::uuid`, [licenseId]);
      });
      await secretsRepo.delete(tenantId, "license.token.current").catch(() => undefined);
      await secretsRepo.delete(tenantId, "license.token.jti").catch(() => undefined);
    }
    if (denylistedJtis.length > 0) {
      await db.delete(revokedTokens).where(inArray(revokedTokens.jti, denylistedJtis));
    }
  });

  async function seedDriftedOfflineGrant(input: {
    jtiInToken: string;
    jtiInSecrets: string;
    jtiInSoT: string;
    licenseStatus: "active" | "suspended" | "revoked";
  }) {
    const token = await signer.sign(
      {
        licenseId,
        tenantId,
        features: ["erp.core"],
        expiresAt: Math.floor(Date.now() / 1000) + 86400,
        serverFingerprint: "phase8-test-fp",
      },
      { jti: input.jtiInToken },
    );

    await secretsRepo.put(tenantId, "license.token.current", token);
    await secretsRepo.put(tenantId, "license.token.jti", input.jtiInSecrets);

    await runWithPlatformContext(async () => {
      await db
        .update(licenses)
        .set({
          status: input.licenseStatus,
          offlineToken: token,
          offlineTokenJti: input.jtiInSoT,
          updatedAt: new Date(),
        })
        .where(eq(licenses.id, licenseId as never));
    });

    return token;
  }

  it("collectOfflineTokenJtisForDenylist gathers SoT, secrets, and verified token jtis", async () => {
    const jtiInToken = randomUUID();
    const jtiInSecrets = randomUUID();
    const jtiInSoT = randomUUID();
    denylistedJtis.push(jtiInToken, jtiInSecrets, jtiInSoT);

    await seedDriftedOfflineGrant({
      jtiInToken,
      jtiInSecrets,
      jtiInSoT,
      licenseStatus: "active",
    });

    const collected = await collectOfflineTokenJtisForDenylist({
      licenseOfflineTokenJti: jtiInSoT,
      licenseOfflineToken: null,
      tenantId,
      secretsRepo,
      cipher,
      signer,
    });

    expect(collected).toContain(jtiInSoT);
    expect(collected).toContain(jtiInSecrets);
    expect(collected).toContain(jtiInToken);
    expect(collected.length).toBe(3);
  });

  it("refreshOfflineEntitlement on suspend revokes cache, clears secrets, and denylist all jtis", async () => {
    const jtiInToken = randomUUID();
    const jtiInSecrets = randomUUID();
    const jtiInSoT = randomUUID();
    denylistedJtis.push(jtiInToken, jtiInSecrets, jtiInSoT);

    await seedDriftedOfflineGrant({
      jtiInToken,
      jtiInSecrets,
      jtiInSoT,
      licenseStatus: "suspended",
    });

    const [licRow] = await runWithPlatformContext(async () =>
      db.select().from(licenses).where(eq(licenses.id, licenseId as never)).limit(1),
    );
    expect(licRow).toBeTruthy();

    const result = await refreshOfflineEntitlement({
      db,
      signer,
      license: licRow as never,
      secretsRepo,
      cipher,
      tokenDenylist: denylist,
    });

    expect(result.action).toBe("revoked");

    expect(await secretsRepo.get(tenantId, "license.token.current")).toBeNull();
    expect(await secretsRepo.get(tenantId, "license.token.jti")).toBeNull();

    expect(await denylist.has(jtiInToken)).toBe(true);
    expect(await denylist.has(jtiInSecrets)).toBe(true);
    expect(await denylist.has(jtiInSoT)).toBe(true);

    const [after] = await runWithPlatformContext(async () =>
      db.select().from(licenses).where(eq(licenses.id, licenseId as never)).limit(1),
    );
    expect(after?.offlineToken).toBeNull();
    expect(after?.offlineTokenJti).toBeNull();
  });

  it("heartbeat after auth reflects Vendor SoT suspended over a still-valid cached token", async () => {
    const jtiInToken = randomUUID();
    await seedDriftedOfflineGrant({
      jtiInToken,
      jtiInSecrets: jtiInToken,
      jtiInSoT: jtiInToken,
      licenseStatus: "suspended",
    });

    const heartbeat = createLicenseHeartbeatMiddleware(
      licenseRepo,
      secretsRepo,
      cipher,
      signer,
    );

    const req = {
      tenantContext: { tenantId, userId: randomUUID(), role: "admin" },
    } as unknown as Request;

    const hb = await runMiddleware(heartbeat, req);
    expect(hb.passed).toBe(true);
    expect(req.license?.status).toBe("suspended");
  });

  it("guard returns LICENSE_SUSPENDED when heartbeat ran after auth on ERP chain", async () => {
    const jtiInToken = randomUUID();
    await seedDriftedOfflineGrant({
      jtiInToken,
      jtiInSecrets: jtiInToken,
      jtiInSoT: jtiInToken,
      licenseStatus: "suspended",
    });

    const heartbeat = createLicenseHeartbeatMiddleware(
      licenseRepo,
      secretsRepo,
      cipher,
      signer,
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
    const blocked = await runMiddleware(guard, req);

    expect(blocked.passed).toBe(false);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.body?.code).toBe("LICENSE_SUSPENDED");
  });

  it("guard fallback returns LICENSE_REVOKED without heartbeat info", async () => {
    await runWithPlatformContext(async () => {
      await db
        .update(licenses)
        .set({ status: "revoked", updatedAt: new Date() })
        .where(eq(licenses.id, licenseId as never));
    });

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

    const blocked = await runMiddleware(guard, req);
    expect(blocked.passed).toBe(false);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.body?.code).toBe("LICENSE_REVOKED");
  });

  it("guard returns LICENSE_TOKEN_REVOKED for denylisted jti even when heartbeat says active", async () => {
    // Restore active SoT after the revoked fallback test.
    await runWithPlatformContext(async () => {
      await db
        .update(licenses)
        .set({ status: "active", updatedAt: new Date() })
        .where(eq(licenses.id, licenseId as never));
    });

    const jti = randomUUID();
    denylistedJtis.push(jti);

    await seedDriftedOfflineGrant({
      jtiInToken: jti,
      jtiInSecrets: jti,
      jtiInSoT: jti,
      licenseStatus: "active",
    });
    await denylist.add(jti, 30 * 24 * 60 * 60);

    const heartbeat = createLicenseHeartbeatMiddleware(
      licenseRepo,
      secretsRepo,
      cipher,
      signer,
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

    const hb = await runMiddleware(heartbeat, req);
    expect(hb.passed).toBe(true);
    expect(req.license?.status).toBe("active");

    const blocked = await runMiddleware(guard, req);
    expect(blocked.passed).toBe(false);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.body?.code).toBe("LICENSE_TOKEN_REVOKED");
  });
});
