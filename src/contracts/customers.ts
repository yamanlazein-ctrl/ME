import type {
  EndpointMeta,
  ApiError,
  ListRequest,
  ListResponse,
  PaginationParams,
  SortParams,
} from "./_shared";
import type {
  PartyDTO,
  CreatePartyInput,
  UpdatePartyInput,
  PartyFilter,
} from "@/core/dtos/PartyDTO";

export type {
  PartyDTO as CustomerDTO,
  CreatePartyInput as CreateCustomerInput,
  UpdatePartyInput as UpdateCustomerInput,
};

export interface CustomerFilter extends PaginationParams, SortParams {
  search?: string;
  status?: "active" | "inactive" | "cancelled" | "all";
}
export type ListCustomersRequest = ListRequest<CustomerFilter>;
export type ListCustomersResponse = ListResponse<PartyDTO>;
export type ListCustomersError = ApiError;
export const ListCustomersEndpoint: EndpointMeta = {
  path: "/api/customers",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant", "warehouse", "viewer"] },
  description: "List customers (parties with kind=customer)",
};

export type CreateCustomerResponse = PartyDTO;
export type CreateCustomerError = ApiError & { code: "VALIDATION_ERROR" | "DUPLICATE_CODE" };
export const CreateCustomerEndpoint: EndpointMeta = {
  path: "/api/customers",
  method: "POST",
  auth: { required: true, roles: ["admin", "accountant"] },
  description: "Create a new customer",
};

export type GetCustomerResponse = PartyDTO;
export type GetCustomerError = ApiError & { code: "NOT_FOUND" };
export const GetCustomerEndpoint: EndpointMeta = {
  path: "/api/customers/:id",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant", "warehouse", "viewer"] },
  description: "Get customer by ID",
};

export type UpdateCustomerResponse = PartyDTO;
export type UpdateCustomerError = ApiError & { code: "NOT_FOUND" | "VALIDATION_ERROR" };
export const UpdateCustomerEndpoint: EndpointMeta = {
  path: "/api/customers/:id",
  method: "PUT",
  auth: { required: true, roles: ["admin", "accountant"] },
  description: "Update customer",
};

export type DeleteCustomerError = ApiError & { code: "NOT_FOUND" | "HAS_TRANSACTIONS" };
export const DeleteCustomerEndpoint: EndpointMeta = {
  path: "/api/customers/:id",
  method: "DELETE",
  auth: { required: true, roles: ["admin"] },
  description: "Delete customer",
};
