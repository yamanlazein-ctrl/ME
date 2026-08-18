import type { CreateExpenseInput, ExpenseDTO } from "@/core/dtos/ExpenseDTO";
import type {
  IExpenseNamesRepository,
  IExpenseRepository,
} from "@/application/ports/IExpenseRepository";
import { ValidationError } from "@/core/errors/DomainError";
import { Err, Ok, type Result } from "@/core/result";

export class CreateExpenseUseCase {
  constructor(
    private readonly repo: IExpenseRepository,
    private readonly names: IExpenseNamesRepository,
  ) {}

  async execute(input: CreateExpenseInput): Promise<Result<ExpenseDTO, ValidationError>> {
    const category = input.category.trim();
    if (!category) return Err(new ValidationError("اسم المصروف مطلوب."));
    if (!input.description) return Err(new ValidationError("الوصف مطلوب."));
    if (!input.amount || input.amount <= 0) return Err(new ValidationError("أدخل مبلغاً صحيحاً."));

    await this.names.add(category);
    const created = await this.repo.create({ ...input, category });
    return Ok(created);
  }
}
