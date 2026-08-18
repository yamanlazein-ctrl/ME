/**
 * Editions & Plans — issuance templates for the License Engine.
 *
 * Frozen Architecture Specification §5. `resolveFeatures` turns a plan (plus
 * optional custom overrides) into the final `features[]` string array that is
 * stored on the license and signed into the offline token. The runtime never
 * reads `plan`/`edition` for gating — only the resulting `features[]`.
 *
 * Design note: `edition` is a product-line identity (erp / pos / restaurant / …)
 * and is recorded on the license but does NOT auto-inject features here. This
 * keeps the concrete examples exact (Basic = [Inventory], Premium =
 * [Inventory, Accounting, Reports]). Custom licenses are supported by
 * `overrides.add` / `overrides.remove` — e.g. premium + manufacturing − hr —
 * which matches NO predefined plan.
 */

import { FEATURES, type FeatureId } from "./features.js";
import type { LicenseLimits } from "./license-metadata.js";

export type Edition = "erp" | "pos" | "restaurant" | "stone_factory" | "medical" | "textile";
export type Plan = "basic" | "standard" | "premium" | "enterprise";

export const EDITIONS: Record<Edition, { name: string }> = {
  erp: { name: "ERP" },
  pos: { name: "POS" },
  restaurant: { name: "Restaurant" },
  stone_factory: { name: "Stone Factory" },
  medical: { name: "Medical" },
  textile: { name: "Textile" },
};

export const PLANS: Record<Plan, FeatureId[]> = {
  basic: [FEATURES.INVENTORY],
  standard: [FEATURES.INVENTORY, FEATURES.SALES, FEATURES.PURCHASING, FEATURES.REPORTS],
  premium: [
    FEATURES.INVENTORY,
    FEATURES.SALES,
    FEATURES.PURCHASING,
    FEATURES.ACCOUNTING,
    FEATURES.REPORTS,
    FEATURES.MULTI_WAREHOUSE,
    FEATURES.API_ACCESS,
  ],
  enterprise: [
    FEATURES.INVENTORY,
    FEATURES.ACCOUNTING,
    FEATURES.REPORTS,
    FEATURES.SALES,
    FEATURES.PURCHASING,
    FEATURES.POS,
    FEATURES.MANUFACTURING,
    FEATURES.HR,
    FEATURES.MULTI_WAREHOUSE,
    FEATURES.MULTI_CURRENCY,
    FEATURES.API_ACCESS,
    FEATURES.AUDIT_LOG,
  ],
};

export const DEFAULT_LIMITS: LicenseLimits = {
  users: 5,
  devices: 1,
  branches: 1,
  warehouses: 1,
  storage_gb: 5,
  api_calls: 10_000,
};

const PLAN_LIMITS: Record<Plan, LicenseLimits> = {
  basic: { users: 5, devices: 1, branches: 1, warehouses: 1, storage_gb: 5, api_calls: 10_000 },
  standard: { users: 20, devices: 2, branches: 2, warehouses: 3, storage_gb: 10, api_calls: 100_000 },
  premium: { users: 50, devices: 5, branches: 5, warehouses: 10, storage_gb: 50, api_calls: 1_000_000 },
  enterprise: {
    users: 200,
    devices: 20,
    branches: 20,
    warehouses: 50,
    storage_gb: 500,
    api_calls: 10_000_000,
  },
};

export interface ResolveOverrides {
  /** Feature ids to ADD on top of the plan (custom license). */
  add?: string[];
  /** Feature ids to REMOVE from the plan (custom license). */
  remove?: string[];
}

/** Resolve the final feature id list (the source of truth for gating). */
export function resolveFeatures(plan: Plan, overrides?: ResolveOverrides): string[] {
  const set = new Set<string>(PLANS[plan]);
  for (const f of overrides?.add ?? []) set.add(f);
  for (const f of overrides?.remove ?? []) set.delete(f);
  return [...set];
}

/** Default numeric limits for a plan (industry presets; overridable later). */
export function defaultLimits(plan: Plan): LicenseLimits {
  return { ...PLAN_LIMITS[plan] };
}

export function isEdition(value: string): value is Edition {
  return value in EDITIONS;
}

export function isPlan(value: string): value is Plan {
  return value in PLANS;
}
