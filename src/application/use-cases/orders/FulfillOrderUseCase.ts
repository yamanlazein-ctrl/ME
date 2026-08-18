import { Order } from "@/domain/entities/Order";
import { NotFoundError } from "@/domain/errors";
import { Ok, Err, type Result } from "@/core/result";
import { TenantContext, UUID } from "@/domain/types";
import { IOrderRepository } from "@/application/ports/IOrderRepository";
import { ValidationError } from "@/domain/errors";

export class FulfillOrderUseCase {
  constructor(private readonly orders: IOrderRepository) {}

  async execute(
    orderId: UUID,
    invoiceId: UUID,
    ctx: TenantContext,
  ): Promise<Result<Order, NotFoundError | ValidationError>> {
    const order = await this.orders.findById(orderId, ctx);
    if (!order) return Err(new NotFoundError("Order", orderId));
    if (!order.canFulfill())
      return Err(new ValidationError("Order cannot be fulfilled in current state.", "status"));
    const result = await this.orders.fulfill(orderId, invoiceId, ctx);
    return Ok(result);
  }
}
