import { Result, Ok, Err } from "@/core/result";
import { ValidationError } from "@/domain/errors";
import { TenantContext } from "@/domain/types";
import {
  IPrintJobRepository,
  ReceivePrintInput,
  PrintJobDTO,
} from "@/application/ports/IPrintJobRepository";

export class ReceivePrintUseCase {
  constructor(private readonly printJobs: IPrintJobRepository) {}

  async execute(
    input: ReceivePrintInput,
    ctx: TenantContext,
  ): Promise<Result<PrintJobDTO, ValidationError>> {
    if (input.receivedKg <= 0) {
      return Err(new ValidationError("الكمية المستلمة يجب أن تكون أكبر من الصفر.", "receivedKg"));
    }
    if (input.printCostPerKg < 0) {
      return Err(new ValidationError("تكلفة الطباعة غير صحيحة.", "printCostPerKg"));
    }
    if (!input.newName?.trim()) {
      return Err(new ValidationError("اسم الصنف الجديد مطلوب.", "newName"));
    }

    const saved = await this.printJobs.receive(input, ctx);
    return Ok(saved);
  }
}
