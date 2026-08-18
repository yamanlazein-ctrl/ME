/**
 * Canonical license metadata types — the signed payload carried by the
 * offline token and stored on the `licenses` row. Frozen Architecture
 * Specification §3.
 *
 * `features[]` + `limits{}` are the RUNTIME SOURCE OF TRUTH. `plan`/`edition`
 * are issuance-time inputs only and are never read for gating (§5.3).
 */

import type { FeatureId } from "./features.js";

/** Abstract binding (§3 binding): decouples the token from a single machine id. */
export type BindingType = "machine" | "server" | "none" | "account";

export interface LicenseBinding {
  type: BindingType;
  value: string; // fingerprint or account id
}

export interface TransferPolicy {
  allowed: boolean;
  max_transfers: number;
  requires_super_admin: boolean;
}

export type UpdateChannel = "stable" | "beta" | "none";

export interface UpdatePolicy {
  channel: UpdateChannel;
  allow_updates: boolean;
  minimum_version: string;
}

export interface BackupPolicy {
  enabled: boolean;
  cloud_backup: boolean;
  max_backups: number;
}

/** Explicit expiry model (§3.1). */
export type LicenseModel = "perpetual" | "subscription";

/** Numeric constraints, independent of features (§3 limits{}). */
export interface LicenseLimits {
  users: number;
  devices: number;
  branches: number;
  warehouses: number;
  storage_gb: number;
  api_calls: number;
}

export interface LicenseMetadata {
  license_id: string;
  company: string;
  edition: string;
  plan: string;
  license_version: string;
  product_version: string;
  license_model: LicenseModel;
  binding: LicenseBinding;
  features: string[];
  limits: LicenseLimits;
  transfer_policy: TransferPolicy;
  update_policy: UpdatePolicy;
  backup_policy: BackupPolicy;
  issued_at: string;
  expires_at: string | null;
  signature?: string;
}

/**
 * Perpetual decision (§3.1): a license is perpetual when its model is
 * `perpetual` AND it has no expiry date. Such a license never blocks on
 * expiry and has no renewal flow.
 */
export function isPerpetual(model: LicenseModel, expiresAt: string | null | Date | undefined): boolean {
  if (model !== "perpetual") return false;
  if (expiresAt == null) return true;
  if (expiresAt instanceof Date) return false;
  return expiresAt.length === 0;
}

/**
 * Feature interpretation by license_version (§3 license_version). v1 is a
 * pass-through; future versions can transform/normalize the feature set here
 * without changing any caller, preserving backward compatibility for old
 * licenses when the feature system evolves.
 */
export function interpretFeatures(_version: string, features: string[]): string[] {
  // v1: features are stored verbatim.
  return features;
}

export function hasFeature(features: string[], feature: FeatureId | string): boolean {
  return features.includes(feature);
}
