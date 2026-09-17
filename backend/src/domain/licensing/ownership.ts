/**
 * Control Plane ownership — canonical identities and who may mutate what.
 *
 * Three planes (product invariant):
 *   1. Vendor Control Plane  — License rights only (plan, features, limits,
 *      status, installations registry, transfer/suspend, releases).
 *   2. Customer Organization — Users, invitations, roles, passwords/PIN,
 *      and device seats within the licensed Max Devices.
 *   3. Local ERP Data Plane  — Business data (invoices, inventory, ledger)
 *      on local PostgreSQL; works offline from a cached entitlement.
 *
 * This module does not talk to the database. It is the shared vocabulary
 * used by enforcement helpers and route comments so ownership stays explicit.
 */

import type { LicenseLimits } from "./license-metadata.js";

/** Who owns a given concern. */
export type ControlPlane = "vendor" | "customer_org" | "local_erp";

/**
 * Canonical identities. Keep these names stable in APIs and docs.
 *
 * | Identity        | Plane         | Meaning                                              |
 * |-----------------|---------------|------------------------------------------------------|
 * | License         | vendor        | Entitlement grant (key, features, limits, status)    |
 * | Installation    | vendor+local  | On-disk UUID; fingerprint = hostHash::installationId |
 * | DeviceSeat      | vendor limit / customer_org manage | Counted seat against Max Devices |
 * | SyncDevice      | local_erp     | Sync transport trust (not a seat by itself)          |
 * | Tenant          | local_erp     | Customer company boundary for ERP rows               |
 * | User            | customer_org  | Local account (password/PIN never leave the org)     |
 * | Invitation      | customer_org  | Org-issued invite; consumes seats, not a license key |
 *
 * Phase 8: `licenses` remains Vendor SoT even when co-located; `tenants.license_*`
 * and `secrets.license.token.*` are caches (see `licenseAuthority.ts`).
 */
export type CanonicalIdentity =
  | "License"
  | "Installation"
  | "DeviceSeat"
  | "SyncDevice"
  | "Tenant"
  | "User"
  | "Invitation";

/** Mutations that only the Vendor Control Plane may perform. */
export const VENDOR_ONLY_ACTIONS = [
  "license.create",
  "license.suspend",
  "license.revoke",
  "license.change_plan",
  "license.change_features",
  "license.change_limits",
  "license.transfer",
  "license.deactivate_activation",
  "releases.publish",
] as const;

export type VendorOnlyAction = (typeof VENDOR_ONLY_ACTIONS)[number];

/** Mutations allowed for a Customer Org admin (within license limits). */
export const CUSTOMER_ORG_ACTIONS = [
  "users.manage",
  "users.reset_password",
  "users.set_pin",
  "invitations.issue",
  "devices.list",
  "devices.revoke_seat",
  "company.settings",
] as const;

export type CustomerOrgAction = (typeof CUSTOMER_ORG_ACTIONS)[number];

export function isVendorOnlyAction(action: string): action is VendorOnlyAction {
  return (VENDOR_ONLY_ACTIONS as readonly string[]).includes(action);
}

/**
 * Runtime Max Devices — single source of truth.
 *
 * Prefer `limits.devices` (signed into the offline token and used by
 * `isWithinLimit`). Fall back to the denormalised `maxDevices` column for
 * legacy rows that pre-date limits JSON. Never invent a third number.
 */
export function resolveDeviceLimit(input: {
  limits?: Partial<LicenseLimits> | null;
  maxDevices?: number | null;
}): number {
  const fromLimits = input.limits?.devices;
  if (typeof fromLimits === "number" && Number.isFinite(fromLimits) && fromLimits >= 0) {
    return fromLimits;
  }
  const fromColumn = input.maxDevices;
  if (typeof fromColumn === "number" && Number.isFinite(fromColumn) && fromColumn >= 0) {
    return fromColumn;
  }
  return 0;
}

/**
 * When issuing or updating a license, keep the column and JSON in lockstep
 * so caches (`tenants.max_devices`) and token payloads never disagree.
 */
export function syncedDeviceLimitFields(deviceLimit: number): {
  maxDevices: number;
  limitsDevices: number;
} {
  const n = Math.max(0, Math.floor(deviceLimit));
  return { maxDevices: n, limitsDevices: n };
}
