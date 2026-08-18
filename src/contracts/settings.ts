import type { EndpointMeta, ApiError } from "./_shared";
import type { UUID, TenantContext } from "@/domain/types";
import type {
  CompanySettingsDTO,
  PrintingSettingsDTO,
  UnitDTO,
  WarehouseDTO,
  TaxDTO,
  PaymentMethodDTO,
  SystemUserDTO,
  ActivityEntryDTO,
  UserRole,
} from "@/application/ports/ISettingsRepository";

export type {
  CompanySettingsDTO,
  PrintingSettingsDTO,
  UnitDTO,
  WarehouseDTO,
  TaxDTO,
  PaymentMethodDTO,
  SystemUserDTO,
  ActivityEntryDTO,
  UserRole,
};

/* ── Company ───────────────────────────────────────────────────── */
export type GetCompanyResponse = CompanySettingsDTO;
export type GetCompanyError = ApiError;
export const GetCompanyEndpoint: EndpointMeta = {
  path: "/api/settings/company",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant"] },
  description: "Get company settings",
};

export type UpdateCompanyError = ApiError & { code: "VALIDATION_ERROR" };
export const UpdateCompanyEndpoint: EndpointMeta = {
  path: "/api/settings/company",
  method: "PUT",
  auth: { required: true, roles: ["admin"] },
  description: "Update company settings",
};

/* ── Printing ──────────────────────────────────────────────────── */
export type GetPrintingSettingsResponse = PrintingSettingsDTO;
export type GetPrintingSettingsError = ApiError;
export const GetPrintingSettingsEndpoint: EndpointMeta = {
  path: "/api/settings/printing",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant"] },
  description: "Get printing preferences",
};

export type UpdatePrintingSettingsError = ApiError & { code: "VALIDATION_ERROR" };
export const UpdatePrintingSettingsEndpoint: EndpointMeta = {
  path: "/api/settings/printing",
  method: "PUT",
  auth: { required: true, roles: ["admin"] },
  description: "Update printing preferences",
};

/* ── Units ──────────────────────────────────────────────────────── */
export type ListUnitsResponse = UnitDTO[];
export type ListUnitsError = ApiError;
export const ListUnitsEndpoint: EndpointMeta = {
  path: "/api/settings/units",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant", "warehouse", "viewer"] },
  description: "List measurement units",
};

export type AddUnitRequest = Omit<UnitDTO, "id">;
export type AddUnitResponse = UnitDTO;
export type AddUnitError = ApiError & { code: "VALIDATION_ERROR" | "DUPLICATE" };
export const AddUnitEndpoint: EndpointMeta = {
  path: "/api/settings/units",
  method: "POST",
  auth: { required: true, roles: ["admin"] },
  description: "Add a new unit",
};

export type UpdateUnitError = ApiError & { code: "NOT_FOUND" | "VALIDATION_ERROR" };
export const UpdateUnitEndpoint: EndpointMeta = {
  path: "/api/settings/units/:id",
  method: "PUT",
  auth: { required: true, roles: ["admin"] },
  description: "Update a unit",
};

export type DeleteUnitError = ApiError & { code: "NOT_FOUND" | "IN_USE" };
export const DeleteUnitEndpoint: EndpointMeta = {
  path: "/api/settings/units/:id",
  method: "DELETE",
  auth: { required: true, roles: ["admin"] },
  description: "Delete a unit",
};

/* ── Warehouses ─────────────────────────────────────────────────── */
export type ListWarehousesResponse = WarehouseDTO[];
export type ListWarehousesError = ApiError;
export const ListWarehousesEndpoint: EndpointMeta = {
  path: "/api/settings/warehouses",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant", "warehouse", "viewer"] },
  description: "List warehouses",
};

export type AddWarehouseRequest = Omit<WarehouseDTO, "id">;
export type AddWarehouseResponse = WarehouseDTO;
export type AddWarehouseError = ApiError & { code: "VALIDATION_ERROR" | "DUPLICATE" };
export const AddWarehouseEndpoint: EndpointMeta = {
  path: "/api/settings/warehouses",
  method: "POST",
  auth: { required: true, roles: ["admin"] },
  description: "Add a new warehouse",
};

export type UpdateWarehouseError = ApiError & { code: "NOT_FOUND" | "VALIDATION_ERROR" };
export const UpdateWarehouseEndpoint: EndpointMeta = {
  path: "/api/settings/warehouses/:id",
  method: "PUT",
  auth: { required: true, roles: ["admin"] },
  description: "Update a warehouse",
};

export type DeleteWarehouseError = ApiError & { code: "NOT_FOUND" | "IN_USE" };
export const DeleteWarehouseEndpoint: EndpointMeta = {
  path: "/api/settings/warehouses/:id",
  method: "DELETE",
  auth: { required: true, roles: ["admin"] },
  description: "Delete a warehouse",
};

/* ── Taxes ──────────────────────────────────────────────────────── */
export type ListTaxesResponse = TaxDTO[];
export type ListTaxesError = ApiError;
export const ListTaxesEndpoint: EndpointMeta = {
  path: "/api/settings/taxes",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant", "viewer"] },
  description: "List tax rates",
};

export type AddTaxRequest = Omit<TaxDTO, "id">;
export type AddTaxResponse = TaxDTO;
export type AddTaxError = ApiError & { code: "VALIDATION_ERROR" | "DUPLICATE" };
export const AddTaxEndpoint: EndpointMeta = {
  path: "/api/settings/taxes",
  method: "POST",
  auth: { required: true, roles: ["admin", "accountant"] },
  description: "Add a new tax rate",
};

export type UpdateTaxError = ApiError & { code: "NOT_FOUND" | "VALIDATION_ERROR" };
export const UpdateTaxEndpoint: EndpointMeta = {
  path: "/api/settings/taxes/:id",
  method: "PUT",
  auth: { required: true, roles: ["admin", "accountant"] },
  description: "Update a tax rate",
};

export type DeleteTaxError = ApiError & { code: "NOT_FOUND" | "IN_USE" };
export const DeleteTaxEndpoint: EndpointMeta = {
  path: "/api/settings/taxes/:id",
  method: "DELETE",
  auth: { required: true, roles: ["admin"] },
  description: "Delete a tax rate",
};

/* ── Payment Methods ────────────────────────────────────────────── */
export type ListPaymentMethodsResponse = PaymentMethodDTO[];
export type ListPaymentMethodsError = ApiError;
export const ListPaymentMethodsEndpoint: EndpointMeta = {
  path: "/api/settings/payment-methods",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant", "viewer"] },
  description: "List payment methods",
};

export type AddPaymentMethodRequest = Omit<PaymentMethodDTO, "id">;
export type AddPaymentMethodResponse = PaymentMethodDTO;
export type AddPaymentMethodError = ApiError & { code: "VALIDATION_ERROR" | "DUPLICATE" };
export const AddPaymentMethodEndpoint: EndpointMeta = {
  path: "/api/settings/payment-methods",
  method: "POST",
  auth: { required: true, roles: ["admin"] },
  description: "Add a new payment method",
};

export type UpdatePaymentMethodError = ApiError & { code: "NOT_FOUND" | "VALIDATION_ERROR" };
export const UpdatePaymentMethodEndpoint: EndpointMeta = {
  path: "/api/settings/payment-methods/:id",
  method: "PUT",
  auth: { required: true, roles: ["admin"] },
  description: "Update a payment method",
};

export type DeletePaymentMethodError = ApiError & { code: "NOT_FOUND" | "IN_USE" };
export const DeletePaymentMethodEndpoint: EndpointMeta = {
  path: "/api/settings/payment-methods/:id",
  method: "DELETE",
  auth: { required: true, roles: ["admin"] },
  description: "Delete a payment method",
};
