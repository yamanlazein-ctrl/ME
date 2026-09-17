/**
 * Phase 8 — License authority boundary (logical split before physical DB split).
 *
 * Until Vendor Control Plane runs on a dedicated database, the co-located
 * `licenses` table is still the authoritative License SoT. Customer ERP must
 * treat everything else as a cache of that grant.
 *
 * | Store                         | Role                                      | Who writes        |
 * |-------------------------------|-------------------------------------------|-------------------|
 * | `licenses`                    | Vendor SoT (rights, limits, status)       | Vendor only       |
 * | `tenants.license_*`           | ERP denormalised entitlement cache        | Vendor sync / activate |
 * | `secrets.license.token.*`     | Offline grant cache (encrypted)           | Activate / refresh |
 * | `licenses.offline_token`      | Baked / refreshed signed grant on SoT row | Vendor bake/refresh |
 *
 * Physical DB split later moves only the Vendor SoT tables out; these
 * roles stay the same so call sites already speak the right vocabulary.
 */

export type LicenseAuthorityStore =
  | "licenses_sot"
  | "tenant_entitlement_cache"
  | "offline_token_cache"
  | "offline_token_on_license_row";

export const LICENSE_AUTHORITY: Record<
  LicenseAuthorityStore,
  { plane: "vendor" | "local_erp"; mutableByCustomerOrg: boolean; description: string }
> = {
  licenses_sot: {
    plane: "vendor",
    mutableByCustomerOrg: false,
    description: "Authoritative License row (plan/features/limits/status)",
  },
  tenant_entitlement_cache: {
    plane: "local_erp",
    mutableByCustomerOrg: false,
    description: "tenants.license_* denormalised cache — never Vendor SoT",
  },
  offline_token_cache: {
    plane: "local_erp",
    mutableByCustomerOrg: false,
    description: "secrets license.token.current — verify offline, refresh from Vendor",
  },
  offline_token_on_license_row: {
    plane: "vendor",
    mutableByCustomerOrg: false,
    description: "licenses.offline_token — bake/refresh artifact on SoT row",
  },
};

/** Terminal statuses: offline grant must be revoked, not re-signed as usable. */
export const LICENSE_TERMINAL_STATUSES = ["suspended", "revoked", "expired"] as const;
export type LicenseTerminalStatus = (typeof LICENSE_TERMINAL_STATUSES)[number];

export function isTerminalLicenseStatus(status: string): status is LicenseTerminalStatus {
  return (LICENSE_TERMINAL_STATUSES as readonly string[]).includes(status);
}

/**
 * What a Vendor mutation should do to the signed offline grant.
 * Pure decision — no I/O.
 */
export function decideEntitlementRefreshAction(status: string): "resign" | "revoke" | "noop" {
  if (isTerminalLicenseStatus(status)) return "revoke";
  if (status === "active" || status === "trial") return "resign";
  return "noop";
}
