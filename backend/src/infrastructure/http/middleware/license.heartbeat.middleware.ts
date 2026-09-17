import type { Request, Response, NextFunction } from "express";
import type { ILicenseRepository } from "../../../application/ports/ILicenseRepository.js";
import type { ITenantRepository } from "../../../application/ports/ITenantRepository.js";
import type { ISecretsRepository } from "../../../application/ports/ISecretsRepository.js";
import type { ISecretCipher } from "../../../application/ports/ISecretCipher.js";
import type { ILicenseTokenSigner } from "../../../application/ports/ILicenseTokenSigner.js";

/**
 * Phase 0 sub-batch 0E — license heartbeat middleware.
 *
 * Per the plan: NEVER blocks waiting for a heartbeat. The middleware
 * uses the cached signed token to verify the license is still valid
 * and sets `req.license = { status, graceRemaining }` for downstream
 * consumers.
 *
 * Behaviour:
 *  - If there is no tenant context (unauthenticated request), skip.
 *  - If there is no active license for the tenant:
 *      - pre-activation → `no_license` (setup may continue)
 *      - post-activation (license_key / activation_id set) → `missing`
 *        so the guard blocks (wizard/PIN must not bypass entitlement)
 *  - If a license is active and the cached offline token verifies,
 *    set `req.license = { status: "active", graceRemaining: days }`.
 *  - If the token is missing or invalid, set `req.license = { status:
 *    "expired", graceRemaining: 0 }`.
 *  - Vendor SoT `suspended`/`revoked` wins over a still-valid offline token.
 */
export interface RequestLicenseStatus {
  status:
    | "active"
    | "expired"
    | "trial"
    | "suspended"
    | "revoked"
    | "no_license"
    | "missing";
  graceRemainingDays?: number;
  licenseId?: string;
}

declare module "express-serve-static-core" {
  interface Request {
    license?: RequestLicenseStatus;
  }
}

export function createLicenseHeartbeatMiddleware(
  licenseRepo: ILicenseRepository,
  secretsRepo: ISecretsRepository,
  cipher: ISecretCipher,
  signer: ILicenseTokenSigner,
  tenantRepo?: ITenantRepository,
) {
  return async function licenseHeartbeat(
    req: Request,
    _res: Response,
    next: NextFunction,
  ): Promise<void> {
    try {
      const ctx = req.tenantContext;
      if (!ctx) {
        next();
        return;
      }
      const lic = await licenseRepo.findLatestForTenant(ctx.tenantId);
      if (!lic) {
        let activated = false;
        if (tenantRepo) {
          const tenant = await tenantRepo.findById(ctx.tenantId as never);
          activated = Boolean(tenant?.activationId || tenant?.licenseKey);
        }
        req.license = activated
          ? { status: "missing", graceRemainingDays: 0 }
          : { status: "no_license" };
        next();
        return;
      }
      // Vendor SoT status wins over a still-valid offline token (suspend/revoke).
      if (lic.status === "suspended" || lic.status === "revoked") {
        req.license = {
          status: lic.status as RequestLicenseStatus["status"],
          graceRemainingDays: 0,
          licenseId: lic.id,
        };
        next();
        return;
      }
      const tokenRow = await secretsRepo.get(ctx.tenantId, "license.token.current");
      if (!tokenRow) {
        req.license = {
          status: lic.status as RequestLicenseStatus["status"],
          graceRemainingDays: 0,
          licenseId: lic.id,
        };
        next();
        return;
      }
      try {
        const plaintext = await cipher.decrypt({
          ciphertext: tokenRow.ciphertext,
          iv: tokenRow.iv,
          authTag: tokenRow.authTag,
          algorithm: tokenRow.algorithm,
        });
        const v = await signer.verify(plaintext);
        // Token licenseId must match the tenant entitlement pointer.
        if (v.payload.licenseId && v.payload.licenseId !== lic.id) {
          req.license = {
            status: "missing",
            graceRemainingDays: 0,
            licenseId: lic.id,
          };
          next();
          return;
        }
        const remaining = Math.max(0, Math.floor((v.exp * 1000 - Date.now()) / 86400000));
        req.license = {
          status: lic.status === "expired" ? "expired" : "active",
          graceRemainingDays: remaining,
          licenseId: v.payload.licenseId,
        };
      } catch {
        req.license = {
          status: "expired",
          graceRemainingDays: 0,
          licenseId: lic.id,
        };
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}
