import { Result, Ok, Err } from "@/core/result";
import { ValidationError, ConflictError } from "@/domain/errors";
import { TenantContext } from "@/domain/types";
import {
  ICashboxRepository,
  CloseDayInput,
  DailyClosingDTO,
} from "@/application/ports/ICashboxRepository";

export class CloseDayUseCase {
  constructor(private readonly cashbox: ICashboxRepository) {}

  async execute(
    input: CloseDayInput,
    ctx: TenantContext,
  ): Promise<Result<DailyClosingDTO, ValidationError | ConflictError>> {
    if (input.counted < 0) {
      return Err(new ValidationError("العد الفعلي يجب أن يكون قيمة موجبة.", "counted"));
    }

    const locked = await this.cashbox.isDayLocked(input.date, ctx);
    if (locked) {
      return Err(new ConflictError(`تم إقفال يوم ${input.date} مسبقاً.`));
    }

    const closing = await this.cashbox.closeDay(input, ctx);
    return Ok(closing);
  }
}
