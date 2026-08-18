import { Result, Ok, Err } from "@/core/result";
import { ValidationError } from "@/domain/errors";
import { TenantContext } from "@/domain/types";
import {
  IPrintJobRepository,
  CreatePrintSendInput,
  PrintJobDTO,
} from "@/application/ports/IPrintJobRepository";

export class CreatePrintSendUseCase {
  constructor(private readonly printJobs: IPrintJobRepository) {}

  async execute(
    input: CreatePrintSendInput,
    ctx: TenantContext,
  ): Promise<Result<PrintJobDTO, ValidationError>> {
    if (!input.pressName?.trim()) {
      return Err(new ValidationError("اسم المطبعة مطلوب.", "pressName"));
    }
    if (input.quantityKg <= 0) {
      return Err(new ValidationError("الكمية يجب أن تكون أكبر من الصفر.", "quantityKg"));
    }

    const saved = await this.printJobs.createSend(input, ctx);
    return Ok(saved);
  }
}
