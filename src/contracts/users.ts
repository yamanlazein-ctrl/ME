import type { EndpointMeta, ApiError } from "./_shared";
import type { SystemUserDTO, UserRole } from "@/application/ports/ISettingsRepository";

export type { SystemUserDTO, UserRole };

export type ListUsersResponse = SystemUserDTO[];
export type ListUsersError = ApiError;
export const ListUsersEndpoint: EndpointMeta = {
  path: "/api/users",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant"] },
  description: "List all system users",
};

export interface CreateUserRequest {
  name: string;
  email: string;
  password: string;
  role: UserRole;
  licenseKey?: string;
}
export type CreateUserResponse = SystemUserDTO;
export type CreateUserError = ApiError & { code: "VALIDATION_ERROR" | "DUPLICATE_EMAIL" };
export const CreateUserEndpoint: EndpointMeta = {
  path: "/api/users",
  method: "POST",
  auth: { required: true, roles: ["admin"] },
  description: "Create a new system user",
};

export type GetUserResponse = SystemUserDTO;
export type GetUserError = ApiError & { code: "NOT_FOUND" };
export const GetUserEndpoint: EndpointMeta = {
  path: "/api/users/:id",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant"] },
  description: "Get user by ID",
};

export interface UpdateUserRequest {
  name?: string;
  email?: string;
  password?: string;
  role?: UserRole;
  active?: boolean;
}
export type UpdateUserResponse = SystemUserDTO;
export type UpdateUserError = ApiError & {
  code: "NOT_FOUND" | "VALIDATION_ERROR" | "DUPLICATE_EMAIL";
};
export const UpdateUserEndpoint: EndpointMeta = {
  path: "/api/users/:id",
  method: "PUT",
  auth: { required: true, roles: ["admin"] },
  description: "Update a system user",
};

export type DeleteUserError = ApiError & { code: "NOT_FOUND" | "CANNOT_DELETE_SELF" };
export const DeleteUserEndpoint: EndpointMeta = {
  path: "/api/users/:id",
  method: "DELETE",
  auth: { required: true, roles: ["admin"] },
  description: "Delete a system user",
};
