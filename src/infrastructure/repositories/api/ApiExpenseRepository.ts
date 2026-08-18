import type { IExpenseRepository } from "@/application/ports/IExpenseRepository";
import type { ExpenseDTO, CreateExpenseInput, ExpenseFilter } from "@/core/dtos/ExpenseDTO";
import { ExpenseApiService } from "@/infrastructure/api";

export class ApiExpenseRepository implements IExpenseRepository {
  constructor(private api: ExpenseApiService) {}

  async list(filter?: ExpenseFilter): Promise<ExpenseDTO[]> {
    const res = await this.api.list(filter);
    return res.data;
  }

  async create(input: CreateExpenseInput): Promise<ExpenseDTO> {
    return this.api.create(input);
  }

  async cancel(id: string): Promise<void> {
    await this.api.cancel(id);
  }
}
