import { Order } from "@/domain/entities/Order";
import { NotFoundError } from "@/domain/errors";
import { Ok, Err, type Result } from "@/core/result";
import { TenantContext, UUID } from "@/domain/types";
import { IOrderRepository } from "@/application/ports/IOrderRepository";
import { ValidationError } from "@/domain/errors";

export class CancelOrderUseCase {
  constructor(private readonly orders: IOrderRepository) {}

  async execute(
    id: UUID,
    ctx: TenantContext,
  ): Promise<Result<Order, NotFoundError | ValidationError>> {
    const order = await this.orders.findById(id, ctx);
    if (!order) return Err(new NotFoundError("Order", id));
    if (!order.canCancel())
      return Err(new ValidationError("Order cannot be cancelled in current state.", "status"));
    const result = await this.orders.cancel(id, ctx);
    return Ok(result);
  }
}
