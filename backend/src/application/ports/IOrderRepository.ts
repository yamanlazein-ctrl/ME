import type { TenantContext, PaginatedResult, UUID } from "../../domain/types/index.js";
import type { OrderData, CreateOrderInput } from "../../domain/entities/Order.js";

export interface OrderFilter {
  customerId?: UUID;
  status?: string;
  search?: string;
  fromDate?: string;
  toDate?: string;
  page?: number;
  limit?: number;
}

export interface IOrderRepository {
  findById(id: string, ctx: TenantContext): Promise<OrderData | null>;
  findByCode(code: string, ctx: TenantContext): Promise<OrderData | null>;
  list(filter: OrderFilter, ctx: TenantContext): Promise<PaginatedResult<OrderData>>;
  create(input: CreateOrderInput, autoCode: string, ctx: TenantContext): Promise<OrderData>;
  update(id: string, data: Partial<CreateOrderInput>, ctx: TenantContext): Promise<OrderData>;
  fulfill(id: string, invoiceId: UUID, ctx: TenantContext): Promise<OrderData>;
  cancel(id: string, ctx: TenantContext): Promise<OrderData>;
}
