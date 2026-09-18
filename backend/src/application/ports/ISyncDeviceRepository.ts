import type { UUID } from "../../domain/types/index.js";

export interface SyncDeviceRow {
  id: UUID;
  tenantId: UUID;
  lastSeenByUserId: UUID | null;
  /**
   * Users this device is provisioned for (Batch 4 / 4B). A device asserted in
   * sync traffic is only accepted from a user in this list — the binding that
   * makes a forged device id detectable.
   */
  authorizedUserIds: UUID[];
  /** Operator revocation. A revoked device may not register, push or pull. */
  revokedAt: Date | null;
  revokeReason: string | null;
  deviceFingerprint: string;
  deviceFingerprintVersion: number;
  platform: string;
  hostname: string | null;
  label: string | null;
  lastSeenAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

export interface IRegisterSyncDeviceInput {
  tenantId: UUID;
  userId: UUID;
  deviceFingerprint: string;
  deviceFingerprintVersion?: number;
  platform: string;
  hostname?: string | null;
  label?: string | null;
  /**
   * Client-asserted device UUID to use as the registry row id. When the id is
   * already registered the announced fingerprint MUST match the stored one —
   * otherwise the caller is claiming someone else's device id and the request
   * is refused (SyncDeviceFingerprintMismatchError). Omitted = the device is
   * resolved (or minted) by fingerprint.
   */
  deviceId?: UUID;
}

/**
 * Raised when an announced device id belongs to a device whose fingerprint does
 * not match the caller's — i.e. a forged/borrowed device id. Maps to 403
 * SYNC_DEVICE_FINGERPRINT_MISMATCH at the route.
 */
export class SyncDeviceFingerprintMismatchError extends Error {
  constructor(readonly deviceId: string) {
    super("معرّف الجهاز مسجّل لجهاز آخر (بصمة غير مطابقة)");
    this.name = "SyncDeviceFingerprintMismatchError";
  }
}

/**
 * Raised when a revoked device (or a fingerprint belonging to one) attempts to
 * register. Maps to 403 SYNC_DEVICE_REVOKED at the route.
 */
export class SyncDeviceRevokedError extends Error {
  constructor(readonly reason: string | null) {
    super("الجهاز مُلغى من المركز — راجع المسؤول لإعادة تفعيله");
    this.name = "SyncDeviceRevokedError";
  }
}

export interface ISyncDeviceRepository {
  /**
   * Register or touch a device.
   *
   * Trust rules (Batch 4 / 4B):
   *  - the tenant always comes from the verified session, never from input;
   *  - a revoked device cannot be registered or touched;
   *  - an announced device id is only adopted when the fingerprint matches the
   *    stored one (physical possession), so a device id can no longer be
   *    silently re-bound by another machine;
   *  - a successful registration binds the authenticated user to the device
   *    (`authorized_user_ids`), which is what the sync transport gate checks.
   */
  registerOrTouch(input: IRegisterSyncDeviceInput): Promise<SyncDeviceRow>;
  /**
   * Tenant-scoped device lookup for the sync transport gate. The hub
   * refuses pushes/pulls that assert an unregistered device id — device
   * identity is self-asserted by header, so registration is what makes it
   * attributable. Returns null when the device is unknown to the tenant.
   */
  findById(tenantId: UUID, deviceId: UUID): Promise<SyncDeviceRow | null>;
  /** Operator view: every device of the tenant, revoked ones included. */
  listForTenant(tenantId: UUID, limit?: number): Promise<SyncDeviceRow[]>;
  /**
   * Revoke (or reinstate) a device. Returns the updated row, or null when the
   * device is unknown to the tenant. Non-destructive: no unit, block or claim
   * is deleted — only the device's authority to act is removed.
   */
  setRevoked(
    tenantId: UUID,
    deviceId: UUID,
    revoked: boolean,
    reason: string | null,
  ): Promise<SyncDeviceRow | null>;
  /**
   * DFP-014: remove a user from every device authorization join (and rebuild
   * denormalized caches). Called on soft-delete / deactivation.
   */
  revokeUserAuthorization(tenantId: UUID, userId: UUID): Promise<void>;
}
