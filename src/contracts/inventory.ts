import type {
  EndpointMeta,
  ApiError,
  ListRequest,
  ListResponse,
  PaginationParams,
  SortParams,
} from "./_shared";
import type { FabricData } from "@/domain/entities/Fabric";
import type { ColorData } from "@/domain/entities/Color";
import type { RollData } from "@/domain/entities/Roll";

/* ── Fabric endpoints ──────────────────────────────────────────── */
export interface FabricFilter extends PaginationParams, SortParams {
  search?: string;
  category?: string;
}
export type ListFabricsRequest = ListRequest<FabricFilter>;
export type ListFabricsResponse = ListResponse<FabricData>;
export type ListFabricsError = ApiError;
export const ListFabricsEndpoint: EndpointMeta = {
  path: "/api/inventory/fabrics",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant", "warehouse", "viewer"] },
  description: "List all fabric types",
};

export type CreateFabricRequest = Omit<FabricData, "id" | "createdAt">;
export type CreateFabricResponse = FabricData;
export type CreateFabricError = ApiError & { code: "VALIDATION_ERROR" | "DUPLICATE_NAME" };
export const CreateFabricEndpoint: EndpointMeta = {
  path: "/api/inventory/fabrics",
  method: "POST",
  auth: { required: true, roles: ["admin", "warehouse"] },
  description: "Create new fabric type",
};

export type GetFabricResponse = FabricData;
export type GetFabricError = ApiError & { code: "NOT_FOUND" };
export const GetFabricEndpoint: EndpointMeta = {
  path: "/api/inventory/fabrics/:id",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant", "warehouse", "viewer"] },
  description: "Get fabric by ID",
};

export type UpdateFabricResponse = FabricData;
export type UpdateFabricError = ApiError & { code: "NOT_FOUND" };
export const UpdateFabricEndpoint: EndpointMeta = {
  path: "/api/inventory/fabrics/:id",
  method: "PUT",
  auth: { required: true, roles: ["admin", "warehouse"] },
  description: "Update fabric",
};

/* ── Color endpoints ───────────────────────────────────────────── */
export interface ColorFilter extends PaginationParams {
  fabricId?: string;
  search?: string;
}
export type ListColorsRequest = ListRequest<ColorFilter>;
export type ListColorsResponse = ListResponse<ColorData>;
export type ListColorsError = ApiError;
export const ListColorsEndpoint: EndpointMeta = {
  path: "/api/inventory/colors",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant", "warehouse", "viewer"] },
  description: "List all colors (optionally by fabricId)",
};

export type CreateColorRequest = Omit<ColorData, "id" | "createdAt">;
export type CreateColorResponse = ColorData;
export type CreateColorError = ApiError & { code: "VALIDATION_ERROR" | "DUPLICATE_NAME" };
export const CreateColorEndpoint: EndpointMeta = {
  path: "/api/inventory/colors",
  method: "POST",
  auth: { required: true, roles: ["admin", "warehouse"] },
  description: "Create new color for a fabric",
};

export type GetColorResponse = ColorData;
export type GetColorError = ApiError & { code: "NOT_FOUND" };
export const GetColorEndpoint: EndpointMeta = {
  path: "/api/inventory/colors/:id",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant", "warehouse", "viewer"] },
  description: "Get color by ID",
};

/* ── Roll endpoints ────────────────────────────────────────────── */
export interface RollFilter extends PaginationParams, SortParams {
  fabricId?: string;
  colorId?: string;
  supplierId?: string;
  status?: "active" | "low" | "out" | "all";
  search?: string;
}
export type ListRollsRequest = ListRequest<RollFilter>;
export type ListRollsResponse = ListResponse<RollData>;
export type ListRollsError = ApiError;
export const ListRollsEndpoint: EndpointMeta = {
  path: "/api/inventory/rolls",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant", "warehouse", "viewer"] },
  description: "List all rolls with filtering",
};

export type CreateRollRequest = Omit<RollData, "id" | "createdAt" | "remainingKg" | "version">;
export type CreateRollResponse = RollData;
export type CreateRollError = ApiError & { code: "VALIDATION_ERROR" };
export const CreateRollEndpoint: EndpointMeta = {
  path: "/api/inventory/rolls",
  method: "POST",
  auth: { required: true, roles: ["admin", "warehouse"] },
  description: "Create new roll (entry inventory)",
};

export type GetRollResponse = RollData;
export type GetRollError = ApiError & { code: "NOT_FOUND" };
export const GetRollEndpoint: EndpointMeta = {
  path: "/api/inventory/rolls/:id",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant", "warehouse", "viewer"] },
  description: "Get roll by ID",
};

/* ── Stock operations ──────────────────────────────────────────── */
export interface ReserveStockRequest {
  quantityKg: number;
  expectedVersion: number;
}
export type ReserveStockError = ApiError & {
  code: "NOT_FOUND" | "INSUFFICIENT_STOCK" | "CONCURRENT_MODIFICATION";
};
export const ReserveStockEndpoint: EndpointMeta = {
  path: "/api/inventory/rolls/:id/reserve",
  method: "POST",
  auth: { required: true, roles: ["admin", "warehouse"] },
  description: "Reserve stock from a roll (optimistic locking)",
};

export interface ReleaseStockRequest {
  quantityKg: number;
  expectedVersion: number;
}
export type ReleaseStockError = ApiError & { code: "NOT_FOUND" | "CONCURRENT_MODIFICATION" };
export const ReleaseStockEndpoint: EndpointMeta = {
  path: "/api/inventory/rolls/:id/release",
  method: "POST",
  auth: { required: true, roles: ["admin", "warehouse"] },
  description: "Release previously reserved stock",
};
