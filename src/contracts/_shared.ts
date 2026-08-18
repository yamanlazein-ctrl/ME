import type { UUID, Currency, Timestamp, TenantContext } from "@/domain/types";

export type HttpMethod = "GET" | "POST" | "PUT" | "PATCH" | "DELETE";

export type AuthRequirement = { required: true; roles?: string[] } | { required: false };

export interface PaginationParams {
  page?: number;
  limit?: number;
  cursor?: string;
}

export interface SortParams {
  sortBy?: string;
  sortOrder?: "asc" | "desc";
}

export interface FilterParams {
  search?: string;
  fromDate?: string;
  toDate?: string;
  status?: string;
}

export interface ApiError {
  code: string;
  message: string;
  details?: Record<string, string[]>;
  statusCode: number;
}

export interface PaginatedMeta {
  total: number;
  page: number;
  limit: number;
  hasNext: boolean;
  totalPages: number;
}

export interface ListRequest<TFilters = Record<string, unknown>>
  extends PaginationParams, SortParams, FilterParams {
  filters?: TFilters;
}

export interface ListResponse<T> {
  data: T[];
  meta: PaginatedMeta;
}

export interface ValidationRule {
  field: string;
  type: "string" | "number" | "boolean" | "date" | "uuid" | "email" | "currency" | "enum";
  required?: boolean;
  min?: number;
  max?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  enum?: readonly string[];
  description?: string;
}

export interface EndpointMeta {
  path: string;
  method: HttpMethod;
  auth: AuthRequirement;
  validation?: Record<string, ValidationRule>;
  description?: string;
}

export type { UUID, Currency, Timestamp, TenantContext };
