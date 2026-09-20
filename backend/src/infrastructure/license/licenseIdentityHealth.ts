/**
 * FIN-18: boot-time license identity health.
 *
 * `detachOrphanBakedLicenses` runs at startup to clear baked desktop licenses
 * still attached to a tenant whose current entitlement is a different key. The
 * app must still boot when that maintenance step fails, but the failure must be
 * observable — otherwise a stale cross-tenant license stays attached with
 * nothing reporting it.
 */
let degradedReason: string | null = null;

export function setLicenseIdentityDegraded(reason: string | null): void {
  degradedReason = reason;
}

/** Null when license identity preparation completed successfully. */
export function getLicenseIdentityDegradedReason(): string | null {
  return degradedReason;
}
