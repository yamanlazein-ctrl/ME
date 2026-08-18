import type { ILicenseTokenSigner } from "../../../application/ports/ILicenseTokenSigner.js";
import type { Request, Response, NextFunction } from "express";
import type { ILicenseRepository } from "../../../application/ports/ILicenseRepository.js";
import type { ISecretsRepository } from "../../../application/ports/ISecretsRepository.js";
import type { ISecretCipher } from "../../../application/ports/ISecretCipher.js";
import type { RequestLicenseStatus } from "./license.heartbeat.middleware.js";

/**
 * R17 — license enforcement guard.
 *
 * Runs AFTER `authMiddleware` (so `req.tenantContext` is populated) and
 * AFTER `licenseHeartbeat` (so `req.license` has grace info). Three-tier
 * enforcement:
 *
 * 1. `graceRemainingDays > 0` — allow, but set `X-License-Grace` warning header.
 * 2. `graceRemainingDays <= 0` — block with 403 (read-only period).
 * 3. `status === "revoked"` — block immediately regardless of grace.
 *
 * `trial`/`active`/`suspended`/`no_license` are allowed.
 *
 * R11 — replay/revoke protection: if a signed offline token is present it
 * is verified and its `jti` is checked against the denylist.
 */
const BLOCKED: ReadonlySet<string> = new Set(["expired", "revoked"]);

export interface LicenseGuardDeps {
  licenseRepo: ILicenseRepository;
  secretsRepo: ISecretsRepository;
  signer: ILicenseTokenSigner;
  cipher: ISecretCipher;
  tokenDenylist: { has: (jti: string) => Promise<boolean> };
}

export function createLicenseGuard(deps: LicenseGuardDeps) {
  return async function licenseGuard(
    req: Request,
    res: Response,
    next: NextFunction,
  ): Promise<void> {
    const ctx = req.tenantContext;
    if (!ctx) {
      next();
      return;
    }
    try {
      // Use heartbeat middleware's cached license info for grace enforcement
      const heartbeatInfo = req.license as RequestLicenseStatus | undefined;

      if (heartbeatInfo) {
        const status = heartbeatInfo.status;

        if (status === "revoked") {
          res.status(403).json({
            code: "LICENSE_REVOKED",
            message: "تم إلغاء الترخيص. راجع لوحة التراخيص.",
            statusCode: 403,
          });
          return;
        }

        if (status === "expired") {
          const grace = heartbeatInfo.graceRemainingDays ?? 0;
          if (grace <= 0) {
            res.status(403).json({
              code: "LICENSE_EXPIRED",
              message: "انتهى الترخيص وانتهت فترة السماح. النظام متاح للقراءة فقط.",
              statusCode: 403,
            });
            return;
          }
          // Grace period active — allow but warn
          res.setHeader("X-License-Grace", String(grace));
        }

        next();
        return;
      }

      // Fallback: no heartbeat info — check license row directly
      const lic = await deps.licenseRepo.findLatestForTenant(ctx.tenantId);
      if (lic && BLOCKED.has(lic.status)) {
        res.status(403).json({
          code: "LICENSE_INVALID",
          message: "الترخيص غير صالح أو منتهٍ. راجع لوحة التراخيص.",
          statusCode: 403,
        });
        return;
      }

      // R11: revoke/replay check via the persisted offline token.
      const tokenRow = await deps.secretsRepo.get(ctx.tenantId, "license.token.current");
      if (tokenRow) {
        try {
          const plaintext = await deps.cipher.decrypt({
            ciphertext: tokenRow.ciphertext,
            iv: tokenRow.iv,
            authTag: tokenRow.authTag,
            algorithm: tokenRow.algorithm,
          });
          const v = await deps.signer.verify(plaintext);
          if (await deps.tokenDenylist.has(v.jti)) {
            res.status(403).json({
              code: "LICENSE_TOKEN_REVOKED",
              message: "تم إلغاء رمز الترخيص. أعد التفعيل للاستمرار.",
              statusCode: 403,
            });
            return;
          }
        } catch {
          // Token invalid/expired — fall through to status-based decision
        }
      }

      next();
    } catch (err) {
      next(err);
    }
  };
}
