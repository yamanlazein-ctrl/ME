/**
 * Port: License token signing/verification abstraction.
 *
 * Allows customer installs to verify tokens and the License Server
 * to sign them. Production uses EdDSA (infrastructure/auth/LicenseTokenSigner.ts).
 * Tests can inject a mock for fast verification.
 */

import type {
  BindingType,
  LicenseLimits,
  LicenseModel,
  TransferPolicy,
  UpdatePolicy,
  BackupPolicy,
} from "../../domain/licensing/license-metadata.js";

export interface LicenseTokenPayload {
  licenseId: string;
  tenantId: string;
  features: string[];
  expiresAt: number; // epoch seconds
  serverFingerprint: string;
  // ── License Engine extensions (frozen spec §3) ──
  edition: string;
  plan: string;
  licenseVersion: string;
  productVersion: string;
  licenseModel: LicenseModel;
  bindingType: BindingType | string;
  bindingValue: string;
  limits: LicenseLimits;
  transferPolicy: TransferPolicy;
  updatePolicy: UpdatePolicy;
  backupPolicy: BackupPolicy;
}

export interface LicenseTokenVerification {
  payload: LicenseTokenPayload;
  jti: string;
  iat: number;
  exp: number;
}

export interface ILicenseTokenSigner {
  sign(payload: LicenseTokenPayload, opts?: { expiresInSec?: number; jti?: string }): Promise<string>;
  verify(token: string): Promise<LicenseTokenVerification>;
}