import type {
  EndpointMeta,
  ApiError,
  PaginationParams,
  SortParams,
  ListRequest,
  ListResponse,
} from "./_shared";
import type {
  ExpenseDTO,
  CreateExpenseInput,
  ExpenseFilter as ExpenseFilterBase,
} from "@/core/dtos/ExpenseDTO";

export type { ExpenseDTO, CreateExpenseInput };

export interface ExpenseFilter extends PaginationParams, SortParams {
  category?: string;
  from?: string;
  to?: string;
  status?: string;
}
export type ListExpensesRequest = ListRequest<ExpenseFilter>;
export type ListExpensesResponse = ListResponse<ExpenseDTO>;
export type ListExpensesError = ApiError;
export const ListExpensesEndpoint: EndpointMeta = {
  path: "/api/expenses",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant", "viewer"] },
  description: "List expenses with filtering and pagination",
};

export type CreateExpenseResponse = ExpenseDTO;
export type CreateExpenseError = ApiError & { code: "VALIDATION_ERROR" };
export const CreateExpenseEndpoint: EndpointMeta = {
  path: "/api/expenses",
  method: "POST",
  auth: { required: true, roles: ["admin", "accountant"] },
  description: "Create a new expense",
};

export type GetExpenseResponse = ExpenseDTO;
export type GetExpenseError = ApiError & { code: "NOT_FOUND" };
export const GetExpenseEndpoint: EndpointMeta = {
  path: "/api/expenses/:id",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant", "viewer"] },
  description: "Get expense by ID",
};

export type UpdateExpenseResponse = ExpenseDTO;
export type UpdateExpenseError = ApiError & { code: "NOT_FOUND" | "VALIDATION_ERROR" };
export const UpdateExpenseEndpoint: EndpointMeta = {
  path: "/api/expenses/:id",
  method: "PUT",
  auth: { required: true, roles: ["admin", "accountant"] },
  description: "Update expense",
};

export type CancelExpenseError = ApiError & { code: "NOT_FOUND" | "INVALID_STATE" };
export const CancelExpenseEndpoint: EndpointMeta = {
  path: "/api/expenses/:id/cancel",
  method: "POST",
  auth: { required: true, roles: ["admin", "accountant"] },
  description: "Cancel an expense",
};

export type ListExpenseNamesResponse = string[];
export type ListExpenseNamesError = ApiError;
export const ListExpenseNamesEndpoint: EndpointMeta = {
  path: "/api/expenses/names",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant", "viewer"] },
  description: "List all expense category names",
};

export interface AddExpenseNameRequest {
  name: string;
}
export type AddExpenseNameError = ApiError & { code: "VALIDATION_ERROR" | "DUPLICATE" };
export const AddExpenseNameEndpoint: EndpointMeta = {
  path: "/api/expenses/names",
  method: "POST",
  auth: { required: true, roles: ["admin", "accountant"] },
  description: "Add a new expense category name",
};
