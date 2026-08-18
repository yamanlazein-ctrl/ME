import { Result, Ok, Err } from "@/core/result";
import { ValidationError } from "@/domain/errors";
import { TenantContext } from "@/domain/types";
import {
  IReturnRepository,
  CreateReturnInput,
  ReturnDTO,
} from "@/application/ports/IReturnRepository";

export class CreateReturnUseCase {
  constructor(private readonly returns: IReturnRepository) {}

  async execute(
    input: CreateReturnInput,
    ctx: TenantContext,
  ): Promise<Result<ReturnDTO, ValidationError>> {
    if (!input.partyId) {
      return Err(new ValidationError("الطرف مطلوب.", "partyId"));
    }
    if (!input.lines?.length) {
      return Err(new ValidationError("يجب إضافة بند واحد على الأقل.", "lines"));
    }
    if (input.lines.some((l) => l.quantityKg <= 0 || l.pricePerKg < 0)) {
      return Err(new ValidationError("الكمية والسعر يجب أن يكونا موجبين.", "lines"));
    }

    const saved = await this.returns.create(input, ctx);
    return Ok(saved);
  }
}
