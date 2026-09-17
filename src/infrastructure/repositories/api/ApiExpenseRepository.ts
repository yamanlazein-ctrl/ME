import type { IExpenseRepository } from "@/application/ports/IExpenseRepository";
import type { ExpenseDTO, CreateExpenseInput, ExpenseFilter } from "@/core/dtos/ExpenseDTO";
import { ExpenseApiService } from "@/infrastructure/api";

export class ApiExpenseRepository implements IExpenseRepository {
  constructor(private api: ExpenseApiService) {}

  async list(filter?: ExpenseFilter): Promise<ExpenseDTO[]> {
    const res = await this.api.list(filter);
    return res.data;
  }

  async findById(id: string): Promise<ExpenseDTO | null> {
    try {
      return await this.api.findById(id);
    } catch (e) {
      if ((e as unknown as { statusCode?: number }).statusCode === 404) return null;
      if ((e as unknown as { code?: string }).code === "NOT_FOUND") return null;
      throw e;
    }
  }

  async create(input: CreateExpenseInput): Promise<ExpenseDTO> {
    return this.api.create(input);
  }

  async cancel(id: string, expectedVersion: number): Promise<void> {
    await this.api.cancel(id, expectedVersion);
  }
}
