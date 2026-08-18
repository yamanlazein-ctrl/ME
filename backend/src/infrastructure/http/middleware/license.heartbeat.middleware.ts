import type { Request, Response, NextFunction } from "express";
import type { ILicenseRepository } from "../../../application/ports/ILicenseRepository.js";
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
 *  - If there is no active license for the tenant, set
 *    `req.license = { status: "no_license" }` and let the route decide.
 *  - If a license is active and the cached offline token verifies,
 *    set `req.license = { status: "active", graceRemaining: days }`.
 *  - If the token is missing or invalid, set `req.license = { status:
 *    "expired", graceRemaining: 0 }`. The customer install is then
 *    read-only (enforced in 0K by checking req.license.status in the
 *    write paths).
 *  - Network failure to the License Server: the middleware uses the
 *    CACHED token, not a live call. The 6h heartbeat (sub-batch 0E
 *    use-case) is what would update the cache; that is run by a
 *    separate background job, not by this middleware.
 */
export interface RequestLicenseStatus {
  status: "active" | "expired" | "trial" | "suspended" | "revoked" | "no_license";
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
      const lic = await licenseRepo.findActiveForTenant(ctx.tenantId);
      if (!lic) {
        req.license = { status: "no_license" };
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
        const remaining = Math.max(0, Math.floor((v.exp * 1000 - Date.now()) / 86400000));
        req.license = {
          status: "active",
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
