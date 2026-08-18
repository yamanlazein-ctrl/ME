import type { UUID } from "../../domain/types/index.js";

/**
 * Phase 0 sub-batch 0G — company profile repository port.
 *
 * The `company_profiles` table (1:1 with `tenants`) holds the
 * company-level configuration captured by the Initial Setup Wizard.
 */
export interface CompanyProfileRow {
  id: UUID;
  tenantId: UUID;
  name: string;
  commercialReg: string | null;
  taxNumber: string | null;
  address: string | null;
  city: string | null;
  country: string | null;
  phone: string | null;
  email: string | null;
  logoPath: string | null;
  currency: string;
  language: string;
  fiscalYearStart: string | null; // YYYY-MM-DD
  defaultTaxRate: string;
  customization: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

export interface UpsertCompanyProfileInput {
  tenantId: UUID;
  name: string;
  commercialReg?: string;
  taxNumber?: string;
  address?: string;
  city?: string;
  country?: string;
  phone?: string;
  email?: string;
  currency?: string;
  language?: string;
  fiscalYearStart?: string;
  defaultTaxRate?: string;
  customization?: Record<string, unknown>;
}

export interface ICompanyRepository {
  findByTenant(tenantId: UUID): Promise<CompanyProfileRow | null>;
  upsert(input: UpsertCompanyProfileInput): Promise<CompanyProfileRow>;
  setLogoPath(tenantId: UUID, logoPath: string | null): Promise<void>;
}
