import type { CreateExpenseInput, ExpenseDTO, ExpenseFilter } from "@/core/dtos/ExpenseDTO";

export interface IExpenseRepository {
  list(filter?: ExpenseFilter): Promise<ExpenseDTO[]>;
  create(input: CreateExpenseInput): Promise<ExpenseDTO>;
  cancel(id: string): Promise<void>;
}

export interface IExpenseNamesRepository {
  list(): Promise<string[]>;
  add(name: string): Promise<void>;
}
