/**
 * Phase 0 sub-batch 0E — license provider port.
 *
 * The customer install uses an `ILicenseProvider` to talk to the
 * License Server over HTTPS. The default self-hosted impl is in
 * `infrastructure/license/SelfHostedLicenseProvider.ts`; vendor
 * adapters (Keygen.sh, Cryptlex) are stubs that throw
 * `NOT_IMPLEMENTED` until Phase 5.
 *
 * AD-2: grace period is the recovery mechanism. If the License Server
 * is unreachable, the customer install falls back to the cached
 * signed offline token (issued during the last successful
 * activation) for `grace_days` days. After grace, the install is
 * read-only.
 */
export interface ActivationRequest {
  key: string;
  serverFingerprint: string;
  serverFingerprintVersion: number;
  hostname?: string;
  appVersion?: string;
  /**
   * The tenant that is activating this license. When the license was
   * issued by the admin dashboard without a pre-bound tenant
   * (`licenses.tenant_id IS NULL`), the provider binds the license to
   * this tenant during activation. When the license is already bound,
   * this must match the existing binding (otherwise activation is
   * refused with ALREADY_ACTIVE).
   */
  tenantId: string;
}

export interface ActivationResult {
  activationId: string;
  tenantId: string;
  licenseId: string;
  features: string[];
  offlineToken: string; // EdDSA-signed JWT
  jti: string; // R11: token id, denylisted on deactivate/revoke
  lease: {
    graceDays: number;
    nextCheckAt: Date;
  };
  expiresAt: Date | null;
}

export interface LicenseInfo {
  key: string;
  type: "trial" | "full" | "subscription";
  status: "active" | "trial" | "expired" | "suspended" | "revoked";
  issuedAt: Date;
  expiresAt: Date | null;
  maxUsers: number;
  maxDevices: number;
  features: string[];
}

export interface DeviceRegistration {
  deviceId: string;
  platform: "windows" | "macos" | "linux" | "android" | "ios" | "web";
  fingerprint: string;
  fingerprintVersion: number;
  name?: string;
}

export interface DeviceInfo {
  id: string;
  deviceId: string;
  platform: DeviceRegistration["platform"];
  name: string | null;
  lastSeenAt: Date;
  revokedAt: Date | null;
}

export interface HeartbeatResult {
  status: LicenseInfo["status"];
  graceRemainingDays: number;
  nextCheckAt: Date;
}

export interface ILicenseProvider {
  activate(req: ActivationRequest): Promise<ActivationResult>;
  refresh(activationId: string): Promise<HeartbeatResult>;
  deactivate(activationId: string, reason: string): Promise<void>;
  listDevices(activationId: string): Promise<DeviceInfo[]>;
  revokeDevice(activationId: string, deviceId: string, reason: string): Promise<void>;
}
