import { Result, Ok, Err } from "@/core/result";
import { ValidationError } from "@/domain/errors";
import { TenantContext } from "@/domain/types";
import {
  IReturnRepository,
  CreateReturnInput,
  ReturnDTO,
} from "@/application/ports/IReturnRepository";
import { createReturnSchema } from "@erp/shared";

export class CreateReturnUseCase {
  constructor(private readonly returns: IReturnRepository) {}

  async execute(
    input: CreateReturnInput,
    ctx: TenantContext,
  ): Promise<Result<ReturnDTO, ValidationError>> {
    const parsed = createReturnSchema.safeParse(input);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return Err(new ValidationError(first.message, first.path.join(".")));
    }

    const saved = await this.returns.create(parsed.data as CreateReturnInput, ctx);
    return Ok(saved);
  }
}
