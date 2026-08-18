/**
 * Feature Registry — single source of truth for every licensable feature.
 *
 * Frozen Architecture Specification §4. Features are NEVER scattered strings:
 * every feature is defined exactly once here, and both the admin dashboard
 * and the runtime enforcement read the `id` (namespaced) while deriving
 * display metadata (name/description/category) from this registry.
 *
 * Enforcement depends only on the `id` strings present in a license's
 * `features[]`; the registry is the catalogue behind those strings.
 */

export interface FeatureDefinition {
  /** Namespaced, stable id used in tokens, DB and API (e.g. "feature.inventory"). */
  id: string;
  name: string;
  description: string;
  category: string;
  /** license_version in which the feature was introduced. */
  introducedIn: string;
  /** license_version in which the feature was deprecated, or null. */
  deprecatedIn: string | null;
}

export const FEATURES = {
  INVENTORY: "feature.inventory",
  ACCOUNTING: "feature.accounting",
  REPORTS: "feature.reports",
  SALES: "feature.sales",
  PURCHASING: "feature.purchasing",
  POS: "feature.pos",
  MANUFACTURING: "feature.manufacturing",
  HR: "feature.hr",
  MULTI_WAREHOUSE: "feature.multi_warehouse",
  MULTI_CURRENCY: "feature.multi_currency",
  API_ACCESS: "feature.api_access",
  AUDIT_LOG: "feature.audit_log",
} as const;

export type FeatureId = (typeof FEATURES)[keyof typeof FEATURES];

export const FEATURE_REGISTRY: Record<FeatureId, FeatureDefinition> = {
  [FEATURES.INVENTORY]: {
    id: FEATURES.INVENTORY,
    name: "Inventory",
    description: "Stock and item management",
    category: "warehouse",
    introducedIn: "v1",
    deprecatedIn: null,
  },
  [FEATURES.ACCOUNTING]: {
    id: FEATURES.ACCOUNTING,
    name: "Accounting",
    description: "Chart of accounts, ledger and financial reports",
    category: "finance",
    introducedIn: "v1",
    deprecatedIn: null,
  },
  [FEATURES.REPORTS]: {
    id: FEATURES.REPORTS,
    name: "Reports",
    description: "Analytical and operational reports",
    category: "analytics",
    introducedIn: "v1",
    deprecatedIn: null,
  },
  [FEATURES.SALES]: {
    id: FEATURES.SALES,
    name: "Sales",
    description: "Sales orders and invoicing",
    category: "sales",
    introducedIn: "v1",
    deprecatedIn: null,
  },
  [FEATURES.PURCHASING]: {
    id: FEATURES.PURCHASING,
    name: "Purchasing",
    description: "Purchase orders and supplier management",
    category: "procurement",
    introducedIn: "v1",
    deprecatedIn: null,
  },
  [FEATURES.POS]: {
    id: FEATURES.POS,
    name: "Point of Sale",
    description: "POS terminal operations",
    category: "sales",
    introducedIn: "v1",
    deprecatedIn: null,
  },
  [FEATURES.MANUFACTURING]: {
    id: FEATURES.MANUFACTURING,
    name: "Manufacturing",
    description: "Production and job management",
    category: "production",
    introducedIn: "v1",
    deprecatedIn: null,
  },
  [FEATURES.HR]: {
    id: FEATURES.HR,
    name: "Human Resources",
    description: "Employees and payroll",
    category: "people",
    introducedIn: "v1",
    deprecatedIn: null,
  },
  [FEATURES.MULTI_WAREHOUSE]: {
    id: FEATURES.MULTI_WAREHOUSE,
    name: "Multi-Warehouse",
    description: "Manage multiple warehouses",
    category: "warehouse",
    introducedIn: "v1",
    deprecatedIn: null,
  },
  [FEATURES.MULTI_CURRENCY]: {
    id: FEATURES.MULTI_CURRENCY,
    name: "Multi-Currency",
    description: "Transact in multiple currencies",
    category: "finance",
    introducedIn: "v1",
    deprecatedIn: null,
  },
  [FEATURES.API_ACCESS]: {
    id: FEATURES.API_ACCESS,
    name: "API Access",
    description: "Programmatic API access",
    category: "integration",
    introducedIn: "v1",
    deprecatedIn: null,
  },
  [FEATURES.AUDIT_LOG]: {
    id: FEATURES.AUDIT_LOG,
    name: "Audit Log",
    description: "Tamper-evident audit trail",
    category: "compliance",
    introducedIn: "v1",
    deprecatedIn: null,
  },
};

export function isFeatureId(value: string): value is FeatureId {
  return (Object.values(FEATURES) as string[]).includes(value);
}

export function getFeature(id: string): FeatureDefinition | undefined {
  return (FEATURE_REGISTRY as Record<string, FeatureDefinition>)[id];
}
