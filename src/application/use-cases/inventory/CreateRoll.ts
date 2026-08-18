import { Result, Ok, Err } from "@/core/result";
import { ValidationError, NotFoundError } from "@/domain/errors";
import { Roll, RollData } from "@/domain/entities/Roll";
import { TenantContext } from "@/domain/types";
import { IInventoryRepository } from "@/application/ports";

export class CreateRollUseCase {
  constructor(private readonly inventory: IInventoryRepository) {}

  async execute(
    input: Omit<RollData, "id" | "tenantId" | "createdAt" | "remainingKg" | "version">,
    ctx: TenantContext,
  ): Promise<Result<Roll, ValidationError>> {
    if (!input.rollNo?.trim()) {
      return Err(new ValidationError("رقم الصبغة مطلوب.", "rollNo"));
    }
    if (input.initialKg <= 0) {
      return Err(new ValidationError("الكمية يجب أن تكون أكبر من صفر.", "initialKg"));
    }
    if (input.pricePerKg < 0) {
      return Err(new ValidationError("السعر لا يمكن أن يكون سالباً.", "pricePerKg"));
    }

    const roll = Roll.create({
      ...input,
      tenantId: ctx.tenantId,
    });

    const saved = await this.inventory.createRoll(roll, ctx);
    return Ok(saved);
  }
}
