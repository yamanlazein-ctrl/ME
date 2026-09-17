import { and, eq } from "drizzle-orm";
import type { DB } from "../orm/drizzle.js";
import { runWithTenantContext } from "../orm/tenant-context.js";
import { deviceRegistrations } from "../orm/schemas/device-registration.table.js";
import { syncDevices } from "../orm/schemas/sync-device.table.js";

/**
 * Shared identity between license `device_registrations` and sync
 * `sync_devices` is the tenant-scoped device fingerprint.
 */
export async function isLicenseFingerprintRevoked(
  db: DB,
  tenantId: string,
  fingerprint: string,
): Promise<boolean> {
  return runWithTenantContext({ tenantId }, async () => {
    const rows = await db
      .select({ revokedAt: deviceRegistrations.revokedAt })
      .from(deviceRegistrations)
      .where(
        and(
          eq(deviceRegistrations.tenantId, tenantId),
          eq(deviceRegistrations.deviceFingerprint, fingerprint),
        ),
      );
    return rows.some((r) => r.revokedAt != null);
  });
}

export async function revokeSyncDevicesByFingerprint(
  db: DB,
  tenantId: string,
  fingerprint: string,
  revoked: boolean,
  reason: string | null,
): Promise<void> {
  const now = new Date();
  await runWithTenantContext({ tenantId }, async () => {
    await db
      .update(syncDevices)
      .set({
        revokedAt: revoked ? now : null,
        revokeReason: revoked ? (reason ?? "linked_revocation") : null,
        updatedAt: now,
      })
      .where(
        and(eq(syncDevices.tenantId, tenantId), eq(syncDevices.deviceFingerprint, fingerprint)),
      );
  });
}

export async function revokeLicenseDevicesByFingerprint(
  db: DB,
  tenantId: string,
  fingerprint: string,
  revoked: boolean,
  reason: string | null,
): Promise<void> {
  const now = new Date();
  await runWithTenantContext({ tenantId }, async () => {
    await db
      .update(deviceRegistrations)
      .set({
        revokedAt: revoked ? now : null,
        revokeReason: revoked ? (reason ?? "linked_revocation") : null,
      })
      .where(
        and(
          eq(deviceRegistrations.tenantId, tenantId),
          eq(deviceRegistrations.deviceFingerprint, fingerprint),
        ),
      );
  });
}
