import type {
  EndpointMeta,
  ApiError,
  ListRequest,
  ListResponse,
  PaginationParams,
  SortParams,
} from "./_shared";
import type { PartyDTO, CreatePartyInput, UpdatePartyInput } from "@/core/dtos/PartyDTO";

export type {
  PartyDTO as SupplierDTO,
  CreatePartyInput as CreateSupplierInput,
  UpdatePartyInput as UpdateSupplierInput,
};

export interface SupplierFilter extends PaginationParams, SortParams {
  search?: string;
  status?: "active" | "inactive" | "cancelled" | "all";
}
export type ListSuppliersRequest = ListRequest<SupplierFilter>;
export type ListSuppliersResponse = ListResponse<PartyDTO>;
export type ListSuppliersError = ApiError;
export const ListSuppliersEndpoint: EndpointMeta = {
  path: "/api/suppliers",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant", "warehouse", "viewer"] },
  description: "List suppliers (parties with kind=supplier)",
};

export type CreateSupplierResponse = PartyDTO;
export type CreateSupplierError = ApiError & { code: "VALIDATION_ERROR" | "DUPLICATE_CODE" };
export const CreateSupplierEndpoint: EndpointMeta = {
  path: "/api/suppliers",
  method: "POST",
  auth: { required: true, roles: ["admin", "accountant"] },
  description: "Create a new supplier",
};

export type GetSupplierResponse = PartyDTO;
export type GetSupplierError = ApiError & { code: "NOT_FOUND" };
export const GetSupplierEndpoint: EndpointMeta = {
  path: "/api/suppliers/:id",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant", "warehouse", "viewer"] },
  description: "Get supplier by ID",
};

export type UpdateSupplierResponse = PartyDTO;
export type UpdateSupplierError = ApiError & { code: "NOT_FOUND" | "VALIDATION_ERROR" };
export const UpdateSupplierEndpoint: EndpointMeta = {
  path: "/api/suppliers/:id",
  method: "PUT",
  auth: { required: true, roles: ["admin", "accountant"] },
  description: "Update supplier",
};

export type DeleteSupplierError = ApiError & { code: "NOT_FOUND" | "HAS_TRANSACTIONS" };
export const DeleteSupplierEndpoint: EndpointMeta = {
  path: "/api/suppliers/:id",
  method: "DELETE",
  auth: { required: true, roles: ["admin"] },
  description: "Delete supplier",
};
