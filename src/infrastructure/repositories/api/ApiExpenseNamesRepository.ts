import type { IExpenseNamesRepository } from "@/application/ports/IExpenseRepository";
import { ExpenseApiService } from "@/infrastructure/api";

export class ApiExpenseNamesRepository implements IExpenseNamesRepository {
  constructor(private api: ExpenseApiService) {}

  async list(): Promise<string[]> {
    return this.api.listNames();
  }

  async add(name: string): Promise<void> {
    await this.api.addName(name);
  }
}
