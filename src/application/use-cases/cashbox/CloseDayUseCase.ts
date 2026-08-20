import { Result, Ok, Err } from "@/core/result";
import { ValidationError, ConflictError } from "@/domain/errors";
import { TenantContext } from "@/domain/types";
import {
  ICashboxRepository,
  CloseDayInput,
  DailyClosingDTO,
} from "@/application/ports/ICashboxRepository";
import { closeDaySchema } from "@erp/shared";

export class CloseDayUseCase {
  constructor(private readonly cashbox: ICashboxRepository) {}

  async execute(
    input: CloseDayInput,
    ctx: TenantContext,
  ): Promise<Result<DailyClosingDTO, ValidationError | ConflictError>> {
    const parsed = closeDaySchema.safeParse(input);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return Err(new ValidationError(first.message, first.path.join(".")));
    }

    const locked = await this.cashbox.isDayLocked(parsed.data.date, ctx);
    if (locked) {
      return Err(new ConflictError(`تم إقفال يوم ${input.date} مسبقاً.`));
    }

    const closing = await this.cashbox.closeDay(parsed.data as CloseDayInput, ctx);
    return Ok(closing);
  }
}
