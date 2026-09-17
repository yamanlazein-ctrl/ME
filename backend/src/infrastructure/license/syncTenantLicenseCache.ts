import { eq } from "drizzle-orm";
import type { DB } from "../orm/drizzle.js";
import { runWithPlatformContext } from "../orm/tenant-context.js";
import { tenants } from "../orm/schemas/tenant.table.js";
import { resolveDeviceLimit } from "../../domain/licensing/ownership.js";
import type { LicenseLimits } from "../../domain/licensing/license-metadata.js";

/**
 * Push Vendor Control Plane license mutations into the tenant denormalised
 * entitlement cache (`tenants.license_*`). This is not License SoT —
 * see `licenseAuthority.ts`. Pair with `refreshOfflineEntitlement` when a
 * signing key is available so the offline grant matches the SoT row.
 */
export async function syncTenantLicenseCacheFromLicenseRow(
  db: DB,
  lic: {
    id?: string;
    tenantId: string | null;
    status: string;
    type: string;
    key: string;
    expiresAt: Date | null;
    maxDevices: number;
    features: string[];
    limits: unknown;
    edition: string | null;
    plan: string | null;
    licenseVersion: string;
    productVersion: string | null;
    licenseModel: string;
    bindingType: string | null;
    bindingValue: string | null;
    transferPolicy: unknown;
    updatePolicy: unknown;
    backupPolicy: unknown;
    transfersUsed: number;
  },
): Promise<boolean> {
  if (!lic.tenantId) return false;
  const limits = (lic.limits as LicenseLimits | null) ?? null;
  const maxDevices = resolveDeviceLimit({ limits, maxDevices: lic.maxDevices });
  return runWithPlatformContext(async () => {
    const [tenant] = await db
      .select({
        licenseKey: tenants.licenseKey,
      })
      .from(tenants)
      .where(eq(tenants.id, lic.tenantId as never))
      .limit(1);
    if (!tenant) return false;

    // Never let a non-current license (e.g. stale baked Desktop row still
    // sharing tenant_id) overwrite the tenant's entitlement pointer/cache.
    if (tenant.licenseKey && tenant.licenseKey !== lic.key) {
      return false;
    }

    await db
      .update(tenants)
      .set({
        licenseStatus: lic.status,
        licenseType: lic.type,
        licenseKey: lic.key,
        licenseExpiresAt: lic.expiresAt,
        maxDevices,
        licenseEdition: lic.edition,
        licensePlan: lic.plan,
        licenseVersion: lic.licenseVersion,
        productVersion: lic.productVersion,
        licenseModel: lic.licenseModel,
        licenseFeatures: lic.features,
        licenseLimits: (limits ?? {}) as never,
        licenseBindingType: lic.bindingType,
        licenseBindingValue: lic.bindingValue,
        transferPolicy: (lic.transferPolicy ?? {}) as never,
        updatePolicy: (lic.updatePolicy ?? {}) as never,
        backupPolicy: (lic.backupPolicy ?? {}) as never,
        transfersUsed: lic.transfersUsed,
        updatedAt: new Date(),
      })
      .where(eq(tenants.id, lic.tenantId as never));
    return true;
  });
}
