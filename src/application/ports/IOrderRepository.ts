import { Order } from "@/domain/entities/Order";
import type {
  OrderDTO,
  CreateOrderInput,
  UpdateOrderInput,
  OrderFilter,
} from "@/core/dtos/OrderDTO";
import type { PaginatedResult, TenantContext, UUID } from "@/domain/types";

/** One sale line checked against pending customer orders (BUG-07 soft warning). */
export interface PendingConflictLine {
  fabricId?: string | null;
  colorId?: string | null;
  quantityKg: number;
}
export interface PendingConflictItem {
  fabricName: string;
  colorName: string;
  requestedKg: number;
}
export interface PendingConflict {
  orderId: UUID;
  code: string;
  customerNameSnapshot: string;
  items: PendingConflictItem[];
}

export interface IOrderRepository {
  findById(id: UUID, ctx: TenantContext): Promise<Order | null>;
  findByCode(code: string, ctx: TenantContext): Promise<Order | null>;
  list(filter: OrderFilter, ctx: TenantContext): Promise<PaginatedResult<Order>>;
  create(input: CreateOrderInput, ctx: TenantContext): Promise<Order>;
  update(id: UUID, patch: UpdateOrderInput, ctx: TenantContext): Promise<Order>;
  cancel(id: UUID, ctx: TenantContext, expectedVersion: number): Promise<Order>;
  fulfill(id: UUID, invoiceId: UUID, ctx: TenantContext): Promise<Order>;
  findPendingConflicts(
    lines: PendingConflictLine[],
    ctx: TenantContext,
  ): Promise<PendingConflict[]>;
}

export type { OrderDTO, CreateOrderInput, UpdateOrderInput, OrderFilter };
