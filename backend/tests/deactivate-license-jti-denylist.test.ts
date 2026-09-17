import { describe, expect, it, beforeAll } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import type { Request, Response, NextFunction } from "express";
import { AesGcmSecretStore } from "../src/infrastructure/secrets/AesGcmSecretStore.js";
import { LicenseTokenSigner } from "../src/infrastructure/auth/LicenseTokenSigner.js";
import { createLicenseGuard } from "../src/infrastructure/http/middleware/license.guard.middleware.js";
import { deactivateLicenseUseCase } from "../src/application/use-cases/license/licenseUseCases.js";
import type { ISecretsRepository, SecretRecord } from "../src/application/ports/ISecretsRepository.js";
import type { LicenseRow, ActivationRow } from "../src/application/ports/ILicenseRepository.js";

/**
 * Proves deactivateLicenseUseCase denylists the decrypted/canonical jti,
 * not String(SecretRecord) → "[object Object]".
 */

function memorySecrets(cipher: AesGcmSecretStore): ISecretsRepository {
  const store = new Map<string, SecretRecord>();
  const keyOf = (tenantId: string | null, key: string) => `${tenantId ?? "sys"}::${key}`;

  return {
    async get(tenantId, key) {
      return store.get(keyOf(tenantId, key)) ?? null;
    },
    async put(tenantId, key, plaintext) {
      const enc = await cipher.encrypt(plaintext);
      const existing = store.get(keyOf(tenantId, key));
      const version = (existing?.version ?? 0) + 1;
      const row: SecretRecord = {
        id: existing?.id ?? randomUUID(),
        tenantId,
        key,
        ciphertext: enc.ciphertext,
        iv: enc.iv,
        authTag: enc.authTag,
        algorithm: enc.algorithm,
        version,
        rotatedAt: existing ? new Date() : null,
        createdAt: existing?.createdAt ?? new Date(),
      };
      store.set(keyOf(tenantId, key), row);
      return version;
    },
    async delete(tenantId, key) {
      store.delete(keyOf(tenantId, key));
    },
    async rotateAll() {
      return 0;
    },
  };
}

async function runGuard(
  mw: (req: Request, res: Response, next: NextFunction) => void | Promise<void>,
  req: Request,
): Promise<{ statusCode?: number; code?: string; passed: boolean }> {
  return new Promise((resolve, reject) => {
    const res = {
      statusCode: 200,
      status(code: number) {
        this.statusCode = code;
        return this;
      },
      json(body: { code?: string }) {
        resolve({ statusCode: this.statusCode, code: body.code, passed: false });
      },
      setHeader() {},
    } as unknown as Response;
    void Promise.resolve(
      mw(req, res, (err?: unknown) => {
        if (err) reject(err);
        else resolve({ statusCode: res.statusCode, passed: true });
      }),
    ).catch(reject);
  });
}

describe("deactivateLicenseUseCase — canonical JTI denylist", () => {
  let cipher: AesGcmSecretStore;
  let signer: LicenseTokenSigner;

  beforeAll(async () => {
    cipher = new AesGcmSecretStore(randomBytes(32));
    const { privateJwk, publicJwk } = await LicenseTokenSigner.generateKeyPair();
    signer = await LicenseTokenSigner.fromJwk(publicJwk, privateJwk);
  });

  it("denylists decrypted jti (not [object Object]) and guard rejects the token", async () => {
    const tenantId = randomUUID();
    const licenseId = randomUUID();
    const activationId = randomUUID();
    const jtiInToken = randomUUID();
    const jtiInSecrets = randomUUID(); // drifted secret jti
    const jtiInSoT = randomUUID();

    const token = await signer.sign(
      {
        licenseId,
        tenantId,
        features: ["erp.core"],
        expiresAt: Math.floor(Date.now() / 1000) + 86400,
        serverFingerprint: "deactivate-test-fp",
      },
      { jti: jtiInToken },
    );

    const secretsRepo = memorySecrets(cipher);
    await secretsRepo.put(tenantId, "license.token.current", token);
    await secretsRepo.put(tenantId, "license.token.jti", jtiInSecrets);

    const jtiRowBefore = await secretsRepo.get(tenantId, "license.token.jti");
    expect(jtiRowBefore).not.toBeNull();
    // Documents the pre-fix bug shape: coercing the record is never a jti.
    expect(String(jtiRowBefore)).toBe("[object Object]");

    const denylisted = new Set<string>();
    const tokenDenylist = {
      async add(jti: string) {
        denylisted.add(jti);
      },
      async has(jti: string) {
        return denylisted.has(jti);
      },
    };

    const lic = {
      id: licenseId,
      tenantId,
      status: "active",
      offlineToken: token,
      offlineTokenJti: jtiInSoT,
    } as unknown as LicenseRow;

    const activation = {
      id: activationId,
      licenseId,
      tenantId,
    } as unknown as ActivationRow;

    const licenseRepo = {
      async findActiveForTenant() {
        return lic;
      },
      async findActiveActivationForLicense() {
        return activation;
      },
      async findLatestForTenant() {
        return lic;
      },
    };

    const provider = {
      async deactivate() {
        return undefined;
      },
    };

    const result = await deactivateLicenseUseCase(
      provider as never,
      licenseRepo as never,
      secretsRepo,
      cipher,
      signer,
      tokenDenylist,
      { tenantId, userId: randomUUID(), userRole: "admin", userName: "admin" },
      "test-deactivate",
    );

    expect(result.ok).toBe(true);
    expect(denylisted.has("[object Object]")).toBe(false);
    expect(denylisted.has(jtiInToken)).toBe(true);
    expect(denylisted.has(jtiInSecrets)).toBe(true);
    expect(denylisted.has(jtiInSoT)).toBe(true);
    expect(await secretsRepo.get(tenantId, "license.token.current")).toBeNull();
    expect(await secretsRepo.get(tenantId, "license.token.jti")).toBeNull();

    // Re-seed token so guard can verify + denylist-check the jti claim.
    await secretsRepo.put(tenantId, "license.token.current", token);

    const guard = createLicenseGuard({
      licenseRepo: licenseRepo as never,
      secretsRepo,
      signer,
      cipher,
      tokenDenylist,
    });

    const blocked = await runGuard(guard, {
      tenantContext: { tenantId, userId: randomUUID(), role: "admin" },
    } as unknown as Request);

    expect(blocked.passed).toBe(false);
    expect(blocked.statusCode).toBe(403);
    expect(blocked.code).toBe("LICENSE_TOKEN_REVOKED");
  });

  it("still denylists SoT jti when secrets.license.token.jti is missing", async () => {
    const tenantId = randomUUID();
    const licenseId = randomUUID();
    const jtiInSoT = randomUUID();
    const jtiInToken = randomUUID();

    const token = await signer.sign(
      {
        licenseId,
        tenantId,
        features: ["erp.core"],
        expiresAt: Math.floor(Date.now() / 1000) + 86400,
        serverFingerprint: "deactivate-test-fp-2",
      },
      { jti: jtiInToken },
    );

    const secretsRepo = memorySecrets(cipher);
    await secretsRepo.put(tenantId, "license.token.current", token);

    const denylisted = new Set<string>();
    const tokenDenylist = {
      async add(jti: string) {
        denylisted.add(jti);
      },
      async has(jti: string) {
        return denylisted.has(jti);
      },
    };

    const result = await deactivateLicenseUseCase(
      { async deactivate() {} } as never,
      {
        async findActiveForTenant() {
          return {
            id: licenseId,
            tenantId,
            offlineToken: token,
            offlineTokenJti: jtiInSoT,
          } as unknown as LicenseRow;
        },
        async findActiveActivationForLicense() {
          return { id: randomUUID(), licenseId, tenantId } as unknown as ActivationRow;
        },
      } as never,
      secretsRepo,
      cipher,
      signer,
      tokenDenylist,
      { tenantId, userId: randomUUID(), userRole: "admin", userName: "admin" },
      "test",
    );

    expect(result.ok).toBe(true);
    expect(denylisted.has(jtiInSoT)).toBe(true);
    expect(denylisted.has(jtiInToken)).toBe(true);
  });
});
