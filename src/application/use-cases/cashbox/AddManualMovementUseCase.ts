import { Result, Ok, Err } from "@/core/result";
import { ValidationError } from "@/domain/errors";
import { TenantContext } from "@/domain/types";
import {
  ICashboxRepository,
  CreateManualMovementInput,
  ManualMovementDTO,
} from "@/application/ports/ICashboxRepository";
import { addManualMovementSchema } from "@erp/shared";

export class AddManualMovementUseCase {
  constructor(private readonly cashbox: ICashboxRepository) {}

  async execute(
    input: CreateManualMovementInput,
    ctx: TenantContext,
  ): Promise<Result<ManualMovementDTO, ValidationError>> {
    const parsed = addManualMovementSchema.safeParse(input);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return Err(new ValidationError(first.message, first.path.join(".")));
    }

    const saved = await this.cashbox.addManualMovement(parsed.data as CreateManualMovementInput, ctx);
    return Ok(saved);
  }
}
