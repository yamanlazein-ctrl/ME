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
 * 3. `status === "revoked"` / `"suspended"` / `"missing"` — block immediately.
 *
 * `trial`/`active`/`no_license` are allowed only for pre-activation / first boot.
 * After the tenant has an activation pointer, heartbeat reports `missing`
 * instead of `no_license`, and that is blocked here.
 *
 * R11 — replay/revoke protection: if a signed offline token is present it
 * is verified and its `jti` is checked against the denylist.
 */
const BLOCKED: ReadonlySet<string> = new Set(["expired", "revoked", "suspended"]);

/**
 * Remaining grace days for a license row.
 *
 * Policy: an `expired` license stays usable (read-only period, signalled by
 * `X-License-Grace`) until `expiresAt + graceDays` elapses, and is blocked
 * only afterwards. When `expiresAt` is null the row cannot be dated, so the
 * configured `graceDays` is taken at face value.
 *
 * Returns whole days left; 0 means grace is exhausted → block.
 */
export function graceRemainingDaysFor(lic: { expiresAt: Date | null; graceDays: number }): number {
  if (!lic.expiresAt) return Math.max(0, lic.graceDays);
  const deadline = lic.expiresAt.getTime() + lic.graceDays * 86400000;
  return Math.max(0, Math.ceil((deadline - Date.now()) / 86400000));
}

export interface LicenseGuardDeps {
  licenseRepo: ILicenseRepository;
  secretsRepo: ISecretsRepository;
  signer: ILicenseTokenSigner;
  cipher: ISecretCipher;
  tokenDenylist: { has: (jti: string) => Promise<boolean> };
}

export function createLicenseGuard(deps: LicenseGuardDeps) {
  async function rejectIfOfflineTokenDenylisted(
    tenantId: string,
    res: Response,
  ): Promise<boolean> {
    const tokenRow = await deps.secretsRepo.get(tenantId, "license.token.current");
    if (!tokenRow) return false;
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
        return true;
      }
    } catch {
      // Token invalid/expired — leave status-based decisions to the caller.
    }
    return false;
  }

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

        if (status === "missing") {
          res.status(403).json({
            code: "LICENSE_REQUIRED",
            message: "يلزم تفعيل ترخيص صالح للاستمرار.",
            statusCode: 403,
          });
          return;
        }

        if (status === "suspended") {
          res.status(403).json({
            code: "LICENSE_SUSPENDED",
            message: "الترخيص معلّق من المورد. تواصل مع الدعم لإعادة التفعيل.",
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

        // R11 must run on the heartbeat path too: a denylisted jti can still
        // verify as a cryptographically valid token while SoT says active
        // (e.g. after vendor revoke cleared SoT fields then a stale token
        // was re-injected). Skipping denylist here was a production hole.
        if (await rejectIfOfflineTokenDenylisted(ctx.tenantId, res)) return;

        next();
        return;
      }

      // Fallback: no heartbeat info — check license row directly.
      // `revoked` is terminal. `expired` honours the grace period: still
      // inside it → allow + X-License-Grace (read-only period); exhausted
      // → 403. This mirrors the heartbeat branch above so both paths agree.
      const lic = await deps.licenseRepo.findLatestForTenant(ctx.tenantId);
      if (lic && BLOCKED.has(lic.status)) {
        if (lic.status === "revoked") {
          res.status(403).json({
            code: "LICENSE_REVOKED",
            message: "تم إلغاء الترخيص. راجع لوحة التراخيص.",
            statusCode: 403,
          });
          return;
        }
        if (lic.status === "suspended") {
          res.status(403).json({
            code: "LICENSE_SUSPENDED",
            message: "الترخيص معلّق من المورد. تواصل مع الدعم لإعادة التفعيل.",
            statusCode: 403,
          });
          return;
        }
        if (lic.status === "expired") {
          const grace = graceRemainingDaysFor(lic);
          if (grace > 0) {
            res.setHeader("X-License-Grace", String(grace));
            if (await rejectIfOfflineTokenDenylisted(ctx.tenantId, res)) return;
            next();
            return;
          }
          res.status(403).json({
            code: "LICENSE_EXPIRED",
            message: "انتهى الترخيص وانتهت فترة السماح. النظام متاح للقراءة فقط.",
            statusCode: 403,
          });
          return;
        }
      }

      if (await rejectIfOfflineTokenDenylisted(ctx.tenantId, res)) return;

      next();
    } catch (err) {
      next(err);
    }
  };
}
