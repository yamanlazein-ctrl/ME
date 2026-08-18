import { Result, Ok, Err } from "@/core/result";
import { ValidationError } from "@/domain/errors";
import { TenantContext } from "@/domain/types";
import {
  ICashboxRepository,
  CreateManualMovementInput,
  ManualMovementDTO,
} from "@/application/ports/ICashboxRepository";

export class AddManualMovementUseCase {
  constructor(private readonly cashbox: ICashboxRepository) {}

  async execute(
    input: CreateManualMovementInput,
    ctx: TenantContext,
  ): Promise<Result<ManualMovementDTO, ValidationError>> {
    if (input.amount <= 0) {
      return Err(new ValidationError("المبلغ يجب أن يكون أكبر من الصفر.", "amount"));
    }
    if (!input.description?.trim()) {
      return Err(new ValidationError("البيان مطلوب.", "description"));
    }

    const saved = await this.cashbox.addManualMovement(input, ctx);
    return Ok(saved);
  }
}
