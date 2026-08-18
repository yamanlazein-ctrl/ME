import type { UUID } from "../../domain/types/index.js";
import type {
  LicenseLimits,
  LicenseModel,
  TransferPolicy,
  UpdatePolicy,
  BackupPolicy,
} from "../../domain/licensing/license-metadata.js";

/**
 * Phase 0 sub-batch 0E — license repository port (DB-side).
 *
 * The provider (ILicenseProvider) handles the License Server
 * conversation. The repository handles direct DB persistence for
 * operations that don't round-trip the License Server — e.g.
 * listing devices, reading the current activation, or logging
 * license events from middleware (heartbeat, audit).
 *
 * Write paths that go through the provider (`activate`, `deactivate`)
 * do NOT need separate repo methods because the provider is itself
 * the source of truth. The repo is read-mostly.
 */
export interface LicenseRow {
  id: UUID;
  key: string;
  type: string;
  status: string;
  issuedAt: Date;
  expiresAt: Date | null;
  graceDays: number;
  maxDevices: number;
  features: string[];
  vendorId: string | null;
  vendorMetadata: Record<string, unknown> | null;
  tenantId: UUID | null;
  createdAt: Date;
  updatedAt: Date;
  // ── License Engine extensions (frozen spec §3) ──
  edition: string | null;
  plan: string | null;
  licenseVersion: string;
  productVersion: string | null;
  licenseModel: LicenseModel;
  bindingType: string | null;
  bindingValue: string | null;
  limits: LicenseLimits;
  transferPolicy: TransferPolicy;
  updatePolicy: UpdatePolicy;
  backupPolicy: BackupPolicy;
  transfersUsed: number;
}

export interface ActivationRow {
  id: UUID;
  licenseId: UUID;
  tenantId: UUID;
  serverFingerprint: string;
  serverFingerprintVersion: number;
  hostname: string | null;
  appVersion: string | null;
  lastSeenAt: Date;
  deactivatedAt: Date | null;
  deactivationReason: string | null;
  notes: string | null;
  createdAt: Date;
}

export interface DeviceRow {
  id: UUID;
  licenseId: UUID;
  tenantId: UUID;
  deviceId: UUID;
  deviceFingerprint: string;
  deviceFingerprintVersion: number;
  platform: string;
  name: string | null;
  signedToken: string | null;
  signedTokenExpiresAt: Date | null;
  lastSeenAt: Date;
  revokedAt: Date | null;
  revokeReason: string | null;
  createdAt: Date;
}

export interface LicenseEventRow {
  id: number;
  licenseId: UUID | null;
  tenantId: UUID | null;
  eventType: string;
  payload: Record<string, unknown> | null;
  actor: string | null;
  ipAddress: string | null;
  requestId: string | null;
  createdAt: Date;
}

export interface ILicenseRepository {
  // ── License rows ──
  findByKey(key: string): Promise<LicenseRow | null>;
  findById(id: UUID): Promise<LicenseRow | null>;
  findActiveForTenant(tenantId: UUID): Promise<LicenseRow | null>;
  /**
   * R17: return the most recent license row for a tenant, regardless of
   * status, so the enforcement guard can block on `expired`/`revoked`.
   */
  findLatestForTenant(tenantId: UUID): Promise<LicenseRow | null>;
  list(filter: { tenantId?: UUID; status?: string }): Promise<LicenseRow[]>;

  // ── Activation rows ──
  findActivationById(id: UUID): Promise<ActivationRow | null>;
  findActiveActivationForLicense(licenseId: UUID): Promise<ActivationRow | null>;

  // ── Device rows ──
  listDevices(licenseId: UUID): Promise<DeviceRow[]>;

  // ── Audit events ──
  logEvent(event: Omit<LicenseEventRow, "id" | "createdAt">): Promise<void>;
  listEvents(
    filter: { licenseId?: UUID; tenantId?: UUID; eventType?: string; since?: Date; until?: Date },
    pagination: { page: number; pageSize: number },
  ): Promise<{ data: LicenseEventRow[]; total: number }>;
}
