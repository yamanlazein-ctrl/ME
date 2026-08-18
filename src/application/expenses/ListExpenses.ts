import type { ExpenseDTO, ExpenseFilter } from "@/core/dtos/ExpenseDTO";
import type { IExpenseRepository } from "@/application/ports/IExpenseRepository";

export class ListExpensesUseCase {
  constructor(private readonly repo: IExpenseRepository) {}
  execute(filter?: ExpenseFilter): Promise<ExpenseDTO[]> {
    return this.repo.list(filter);
  }
}
