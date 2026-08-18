import type {
  EndpointMeta,
  ApiError,
  ListRequest,
  ListResponse,
  PaginationParams,
  SortParams,
} from "./_shared";
import type {
  OrderDTO,
  CreateOrderInput,
  UpdateOrderInput,
  OrderFilter as OrderFilterBase,
} from "@/core/dtos/OrderDTO";
import type { UUID } from "@/domain/types";

export type { OrderDTO, CreateOrderInput, UpdateOrderInput };

export interface OrderFilter extends PaginationParams, SortParams {
  customerId?: UUID;
  status?: string;
  search?: string;
}
export type ListOrdersRequest = ListRequest<OrderFilter>;
export type ListOrdersResponse = ListResponse<OrderDTO>;
export type ListOrdersError = ApiError;
export const ListOrdersEndpoint: EndpointMeta = {
  path: "/api/orders",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant", "warehouse", "viewer"] },
  description: "List orders with filtering and pagination",
};

export type CreateOrderResponse = OrderDTO;
export type CreateOrderError = ApiError & { code: "VALIDATION_ERROR" };
export const CreateOrderEndpoint: EndpointMeta = {
  path: "/api/orders",
  method: "POST",
  auth: { required: true, roles: ["admin", "accountant"] },
  description: "Create a new order",
};

export type GetOrderResponse = OrderDTO;
export type GetOrderError = ApiError & { code: "NOT_FOUND" };
export const GetOrderEndpoint: EndpointMeta = {
  path: "/api/orders/:id",
  method: "GET",
  auth: { required: true, roles: ["admin", "accountant", "warehouse", "viewer"] },
  description: "Get order by ID",
};

export type UpdateOrderResponse = OrderDTO;
export type UpdateOrderError = ApiError & { code: "NOT_FOUND" | "VALIDATION_ERROR" | "CONFLICT" };
export const UpdateOrderEndpoint: EndpointMeta = {
  path: "/api/orders/:id",
  method: "PUT",
  auth: { required: true, roles: ["admin", "accountant"] },
  description: "Update order",
};

export type CancelOrderResponse = OrderDTO;
export type CancelOrderError = ApiError & { code: "NOT_FOUND" | "INVALID_STATE" };
export const CancelOrderEndpoint: EndpointMeta = {
  path: "/api/orders/:id/cancel",
  method: "POST",
  auth: { required: true, roles: ["admin", "accountant"] },
  description: "Cancel an open order",
};

export interface FulfillOrderRequest {
  invoiceId: UUID;
}
export type FulfillOrderResponse = OrderDTO;
export type FulfillOrderError = ApiError & { code: "NOT_FOUND" | "INVALID_STATE" };
export const FulfillOrderEndpoint: EndpointMeta = {
  path: "/api/orders/:id/fulfill",
  method: "POST",
  auth: { required: true, roles: ["admin", "warehouse"] },
  description: "Mark order as fulfilled with linked invoice",
};
