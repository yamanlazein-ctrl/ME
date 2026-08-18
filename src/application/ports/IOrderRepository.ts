import { Order } from "@/domain/entities/Order";
import type {
  OrderDTO,
  CreateOrderInput,
  UpdateOrderInput,
  OrderFilter,
} from "@/core/dtos/OrderDTO";
import type { PaginatedResult, TenantContext, UUID } from "@/domain/types";

export interface IOrderRepository {
  findById(id: UUID, ctx: TenantContext): Promise<Order | null>;
  findByCode(code: string, ctx: TenantContext): Promise<Order | null>;
  list(filter: OrderFilter, ctx: TenantContext): Promise<PaginatedResult<Order>>;
  create(input: CreateOrderInput, ctx: TenantContext): Promise<Order>;
  update(id: UUID, patch: UpdateOrderInput, ctx: TenantContext): Promise<Order>;
  cancel(id: UUID, ctx: TenantContext): Promise<Order>;
  fulfill(id: UUID, invoiceId: UUID, ctx: TenantContext): Promise<Order>;
}

export type { OrderDTO, CreateOrderInput, UpdateOrderInput, OrderFilter };
