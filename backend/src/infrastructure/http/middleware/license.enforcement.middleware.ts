import type { Request, Response, NextFunction } from "express";
import type { UUID } from "../../../domain/types/index.js";
import type { ILicenseRepository, LicenseRow } from "../../../application/ports/ILicenseRepository.js";
import type { LicenseLimits } from "../../../domain/licensing/license-metadata.js";

/**
 * Phase 5 — License enforcement (frozen spec §9, §6).
 *
 * Three layers (defense in depth):
 *   1. UI     — hides modules via feature flags (client side).
 *   2. Middleware — `requireFeature` blocks API calls to unlicensed modules.
 *   3. Business — `isWithinLimit` is checked inside use-cases (e.g. when
 *                 creating the N+1th user or registering another device),
 *                 so a direct API call can never bypass the limit.
 *
 * `features[]` and `limits{}` are the runtime source of truth; `plan`/
 * `edition` are never consulted here.
 */

export function requireFeature(licenseRepo: ILicenseRepository, ...needed: string[]) {
  return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    const ctx = req.tenantContext;
    if (!ctx) {
      next();
      return;
    }
    try {
      const lic = await licenseRepo.findLatestForTenant(ctx.tenantId as UUID);
      // No license yet (setup/activation in progress) → do not gate.
      if (!lic) {
        next();
        return;
      }
      const have = new Set(lic.features);
      const missing = needed.filter((f) => !have.has(f));
      if (missing.length > 0) {
        res.status(403).json({
          code: "FEATURE_NOT_ENABLED",
          message: "الميزة غير مشمولة في الترخيص",
          statusCode: 403,
          missing,
        });
        return;
      }
      next();
    } catch (err) {
      next(err);
    }
  };
}

/** True when `currentCount` is still below the licensed limit for `key`. */
export function isWithinLimit(
  limits: LicenseLimits,
  key: keyof LicenseLimits,
  currentCount: number,
): boolean {
  return currentCount < (limits[key] ?? 0);
}

export function limitError(key: string) {
  return { code: "LIMIT_EXCEEDED", message: `تجاوزت الحد المسموح: ${key}`, statusCode: 403 };
}

export type { LicenseRow };
