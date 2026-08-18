export type Edition = "erp" | "pos" | "restaurant" | "stone_factory" | "medical" | "textile";
export type Plan = "basic" | "standard" | "premium" | "enterprise";
export type LicenseModel = "perpetual" | "subscription";
export type BindingType = "machine" | "server" | "none" | "account";

export interface LicenseLimits {
  users: number;
  devices: number;
  branches: number;
  warehouses: number;
  storage_gb: number;
  api_calls: number;
}

export interface TransferPolicy {
  allowed: boolean;
  max_transfers: number;
  requires_super_admin: boolean;
}
export interface UpdatePolicy {
  channel: "stable" | "beta" | "none";
  allow_updates: boolean;
  minimum_version: string;
}
export interface BackupPolicy {
  enabled: boolean;
  cloud_backup: boolean;
  max_backups: number;
}

export interface License {
  id: string;
  key: string;
  type: string;
  status: string;
  plan: string | null;
  edition: string | null;
  licenseModel: LicenseModel;
  licenseVersion: string;
  productVersion: string | null;
  bindingType: BindingType | null;
  features: string[];
  limits: LicenseLimits;
  transferPolicy: TransferPolicy;
  updatePolicy: UpdatePolicy;
  backupPolicy: BackupPolicy;
  maxDevices: number;
  tenantId: string | null;
  issuedAt: string;
  expiresAt: string | null;
  companyName?: string;
}

export interface Activation {
  id: string;
  licenseId: string;
  tenantId: string;
  serverFingerprint: string;
  hostname: string;
  appVersion: string;
  lastSeenAt: string;
  deactivatedAt: string | null;
  deactivationReason: string | null;
  createdAt: string;
}

export interface AuditEvent {
  id: number;
  licenseId: string;
  tenantId: string;
  eventType: string;
  payload: unknown;
  actor: string;
  ipAddress: string;
  createdAt: string;
}

export interface CreateLicenseInput {
  companyName: string;
  edition: Edition;
  plan: Plan;
  licenseModel: LicenseModel;
  featureAdd?: string[];
  featureRemove?: string[];
  limits?: Partial<LicenseLimits>;
  bindingType?: BindingType;
  bindingValue?: string;
  transferPolicy?: Partial<TransferPolicy>;
  updatePolicy?: Partial<UpdatePolicy>;
  backupPolicy?: Partial<BackupPolicy>;
  expiresInDays?: number | null;
}

export const EDITIONS: { value: Edition; label: string }[] = [
  { value: "erp", label: "ERP" },
  { value: "pos", label: "POS" },
  { value: "restaurant", label: "مطعم" },
  { value: "stone_factory", label: "مصنع حجر" },
  { value: "medical", label: "طبي" },
  { value: "textile", label: "نسيج" },
];

export const PLANS: { value: Plan; label: string }[] = [
  { value: "basic", label: "Basic" },
  { value: "standard", label: "Standard" },
  { value: "premium", label: "Premium" },
  { value: "enterprise", label: "Enterprise" },
];

// Mirrors the backend PLANS map (frozen spec §5).
export const PLAN_FEATURES: Record<Plan, string[]> = {
  basic: ["feature.inventory"],
  standard: ["feature.inventory", "feature.sales", "feature.purchasing", "feature.reports"],
  premium: [
    "feature.inventory",
    "feature.sales",
    "feature.purchasing",
    "feature.accounting",
    "feature.reports",
    "feature.multi_warehouse",
    "feature.api_access",
  ],
  enterprise: [
    "feature.inventory",
    "feature.accounting",
    "feature.reports",
    "feature.sales",
    "feature.purchasing",
    "feature.pos",
    "feature.manufacturing",
    "feature.hr",
    "feature.multi_warehouse",
    "feature.multi_currency",
    "feature.api_access",
    "feature.audit_log",
  ],
};

export const FEATURES: { value: string; label: string }[] = [
  { value: "feature.inventory", label: "المخزون" },
  { value: "feature.accounting", label: "المحاسبة" },
  { value: "feature.reports", label: "التقارير" },
  { value: "feature.sales", label: "المبيعات" },
  { value: "feature.purchasing", label: "المشتريات" },
  { value: "feature.pos", label: "نقطة البيع" },
  { value: "feature.manufacturing", label: "التصنيع" },
  { value: "feature.hr", label: "الموارد البشرية" },
  { value: "feature.multi_warehouse", label: "مخازن متعددة" },
  { value: "feature.multi_currency", label: "عملات متعددة" },
  { value: "feature.api_access", label: "واجهة API" },
  { value: "feature.audit_log", label: "سجل التدقيق" },
];
