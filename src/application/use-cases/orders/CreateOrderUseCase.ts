import { Order } from "@/domain/entities/Order";
import { ValidationError } from "@/domain/errors";
import { Ok, Err, type Result } from "@/core/result";
import { TenantContext, UUID } from "@/domain/types";
import { IOrderRepository } from "@/application/ports/IOrderRepository";

export class CreateOrderUseCase {
  constructor(private readonly orders: IOrderRepository) {}

  async execute(
    input: {
      customerId?: UUID | null;
      customerNameSnapshot: string;
      customerPhoneSnapshot?: string | null;
      date: string;
      notes?: string | null;
      currency: import("@/domain/types").Currency;
      items: Array<{
        fabricId?: UUID | null;
        fabricName: string;
        colorId?: UUID | null;
        colorName: string;
        colorCode?: string | null;
        requestedKg: number;
        widthCm?: number | null;
        weightGsm?: number | null;
        notes?: string | null;
      }>;
    },
    ctx: TenantContext,
  ): Promise<Result<Order, ValidationError>> {
    if (!input.customerNameSnapshot?.trim()) {
      return Err(new ValidationError("Customer name is required.", "customerName"));
    }
    if (!input.items?.length) {
      return Err(new ValidationError("At least one item is required.", "items"));
    }
    for (const item of input.items) {
      if (!item.fabricName?.trim()) {
        return Err(new ValidationError("Fabric name is required for each item.", "items"));
      }
      if (item.requestedKg <= 0) {
        return Err(new ValidationError("Quantity must be positive.", "items"));
      }
    }

    const order = await this.orders.create(input, ctx);
    return Ok(order);
  }
}
