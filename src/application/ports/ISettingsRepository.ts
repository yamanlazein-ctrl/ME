import type { TenantContext, UUID } from "@/domain/types";

export type UserRole = "admin" | "accountant" | "warehouse" | "viewer";

export interface UnitDTO {
  id: UUID;
  name: string;
  symbol: string;
  isDefault: boolean;
}

export interface TaxDTO {
  id: UUID;
  name: string;
  rate: number;
  enabled: boolean;
}

export interface WarehouseDTO {
  id: UUID;
  name: string;
  location: string;
  isDefault: boolean;
}

export interface PaymentMethodDTO {
  id: UUID;
  name: string;
  enabled: boolean;
}

export interface PrintingSettingsDTO {
  paperSize: "A4" | "A5" | "80mm";
  showLogo: boolean;
  footerNote: string;
  copies: number;
}

export interface CompanySettingsDTO {
  name: string;
  commercialReg: string;
  taxNumber: string;
  phone: string;
  email: string;
  address: string;
  city: string;
}

export interface SystemUserDTO {
  id: UUID;
  name: string;
  email: string;
  role: UserRole;
  active: boolean;
  createdAt: string;
  password?: string;
  licenseKey: string;
}

export interface ActivityEntryDTO {
  id: UUID;
  at: string;
  user: string;
  module: string;
  action: string;
  detail?: string;
}

export interface ISettingsRepository {
  getCompany(ctx: TenantContext): Promise<CompanySettingsDTO>;
  updateCompany(settings: CompanySettingsDTO, ctx: TenantContext): Promise<void>;
  getPrinting(ctx: TenantContext): Promise<PrintingSettingsDTO>;
  updatePrinting(settings: PrintingSettingsDTO, ctx: TenantContext): Promise<void>;
  listUnits(ctx: TenantContext): Promise<UnitDTO[]>;
  addUnit(input: Omit<UnitDTO, "id">, ctx: TenantContext): Promise<UnitDTO>;
  updateUnit(id: UUID, patch: Partial<UnitDTO>, ctx: TenantContext): Promise<void>;
  deleteUnit(id: UUID, ctx: TenantContext): Promise<void>;
  listWarehouses(ctx: TenantContext): Promise<WarehouseDTO[]>;
  addWarehouse(input: Omit<WarehouseDTO, "id">, ctx: TenantContext): Promise<WarehouseDTO>;
  updateWarehouse(id: UUID, patch: Partial<WarehouseDTO>, ctx: TenantContext): Promise<void>;
  deleteWarehouse(id: UUID, ctx: TenantContext): Promise<void>;
  listTaxes(ctx: TenantContext): Promise<TaxDTO[]>;
  addTax(input: Omit<TaxDTO, "id">, ctx: TenantContext): Promise<TaxDTO>;
  updateTax(id: UUID, patch: Partial<TaxDTO>, ctx: TenantContext): Promise<void>;
  deleteTax(id: UUID, ctx: TenantContext): Promise<void>;
  listPaymentMethods(ctx: TenantContext): Promise<PaymentMethodDTO[]>;
  addPaymentMethod(
    input: Omit<PaymentMethodDTO, "id">,
    ctx: TenantContext,
  ): Promise<PaymentMethodDTO>;
  updatePaymentMethod(
    id: UUID,
    patch: Partial<PaymentMethodDTO>,
    ctx: TenantContext,
  ): Promise<void>;
  deletePaymentMethod(id: UUID, ctx: TenantContext): Promise<void>;
  listUsers(ctx: TenantContext): Promise<SystemUserDTO[]>;
  addUser(
    input: Omit<SystemUserDTO, "id" | "createdAt" | "licenseKey"> & { licenseKey?: string },
    ctx: TenantContext,
  ): Promise<SystemUserDTO>;
  updateUser(id: UUID, patch: Partial<SystemUserDTO>, ctx: TenantContext): Promise<void>;
  deleteUser(id: UUID, ctx: TenantContext): Promise<void>;
  regenerateLicenseKey(id: UUID, ctx: TenantContext): Promise<string | undefined>;
  listActivity(ctx: TenantContext): Promise<ActivityEntryDTO[]>;
  clearActivity(ctx: TenantContext): Promise<void>;
  logActivity(module: string, action: string, detail?: string, ctx?: TenantContext): Promise<void>;
}
