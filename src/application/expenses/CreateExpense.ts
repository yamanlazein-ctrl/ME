import type { CreateExpenseInput, ExpenseDTO } from "@/core/dtos/ExpenseDTO";
import type {
  IExpenseNamesRepository,
  IExpenseRepository,
} from "@/application/ports/IExpenseRepository";
import { ValidationError } from "@/core/errors/DomainError";
import { Err, Ok, type Result } from "@/core/result";
import { createExpenseSchema } from "@erp/shared";

export class CreateExpenseUseCase {
  constructor(
    private readonly repo: IExpenseRepository,
    private readonly names: IExpenseNamesRepository,
  ) {}

  async execute(input: CreateExpenseInput): Promise<Result<ExpenseDTO, ValidationError>> {
    const parsed = createExpenseSchema.safeParse(input);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return Err(new ValidationError(first.message));
    }
    const category = parsed.data.category.trim();
    await this.names.add(category);
    const created = await this.repo.create({ ...parsed.data, category } as CreateExpenseInput);
    return Ok(created);
  }
}
