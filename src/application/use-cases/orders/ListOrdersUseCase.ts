import { Order } from "@/domain/entities/Order";
import { TenantContext, PaginatedResult } from "@/domain/types";
import { IOrderRepository, OrderFilter } from "@/application/ports/IOrderRepository";

export class ListOrdersUseCase {
  constructor(private readonly orders: IOrderRepository) {}

  async execute(filter: OrderFilter, ctx: TenantContext): Promise<PaginatedResult<Order>> {
    return this.orders.list(filter, ctx);
  }
}
