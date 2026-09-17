/**
 * Post-activation license access for ERP auth + API surfaces.
 *
 * Pre-activation (no license_key / activation_id on the tenant) → allow.
 * After activation → SoT license status must allow access; PIN/password
 * alone must never bypass suspended/revoked/expired-past-grace.
 */

import type { ILicenseRepository } from "../../application/ports/ILicenseRepository.js";
import type { ITenantRepository } from "../../application/ports/ITenantRepository.js";
import { AuthError } from "../../domain/errors/index.js";
import { graceRemainingDaysFor } from "../http/middleware/license.guard.middleware.js";

export type TenantLicenseAccessOk = { ok: true; licenseId?: string };
export type TenantLicenseAccessDenied = {
  ok: false;
  code: string;
  message: string;
  statusCode: 403;
};

export type TenantLicenseAccessResult = TenantLicenseAccessOk | TenantLicenseAccessDenied;

const MSG = {
  REQUIRED: "يلزم تفعيل ترخيص صالح للاستمرار.",
  SUSPENDED: "الترخيص معلّق من المورد. تواصل مع الدعم لإعادة التفعيل.",
  REVOKED: "تم إلغاء الترخيص. راجع لوحة التراخيص.",
  EXPIRED: "انتهى الترخيص وانتهت فترة السماح.",
} as const;

/**
 * Evaluate whether an already-activated tenant may open a session or
 * continue using the ERP. Does not mutate users/PIN/password.
 */
export async function evaluateTenantLicenseAccess(deps: {
  licenseRepo: ILicenseRepository;
  tenantRepo: ITenantRepository;
  tenantId: string;
}): Promise<TenantLicenseAccessResult> {
  const tenant = await deps.tenantRepo.findById(deps.tenantId as never);
  if (!tenant) {
    return { ok: false, code: "LICENSE_REQUIRED", message: MSG.REQUIRED, statusCode: 403 };
  }

  const activated = Boolean(tenant.activationId || tenant.licenseKey);
  if (!activated) {
    // Fresh install / wizard — license not bound yet.
    return { ok: true };
  }

  const lic = await deps.licenseRepo.findLatestForTenant(deps.tenantId as never);
  if (!lic) {
    return { ok: false, code: "LICENSE_REQUIRED", message: MSG.REQUIRED, statusCode: 403 };
  }

  if (lic.status === "suspended") {
    return { ok: false, code: "LICENSE_SUSPENDED", message: MSG.SUSPENDED, statusCode: 403 };
  }
  if (lic.status === "revoked") {
    return { ok: false, code: "LICENSE_REVOKED", message: MSG.REVOKED, statusCode: 403 };
  }
  if (lic.status === "expired") {
    const grace = graceRemainingDaysFor(lic);
    if (grace <= 0) {
      return { ok: false, code: "LICENSE_EXPIRED", message: MSG.EXPIRED, statusCode: 403 };
    }
  }

  return { ok: true, licenseId: lic.id };
}

/** Throw AuthError (403 via error handler) when access is denied. */
export async function assertTenantLicenseAllowsAccess(deps: {
  licenseRepo: ILicenseRepository;
  tenantRepo: ITenantRepository;
  tenantId: string;
}): Promise<void> {
  const result = await evaluateTenantLicenseAccess(deps);
  if (!result.ok) {
    throw new AuthError(result.code, result.message);
  }
}
