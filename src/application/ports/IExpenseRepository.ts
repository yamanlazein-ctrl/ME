import type { PaginatedResult } from "@/domain/types";
import type { CreateExpenseInput, ExpenseDTO, ExpenseFilter } from "@/core/dtos/ExpenseDTO";

export interface IExpenseRepository {
  list(filter?: ExpenseFilter): Promise<ExpenseDTO[]>;
  /** One page with its paging meta (hasNext / nextCursor) — for "load all" walks. */
  listPage(filter?: ExpenseFilter): Promise<PaginatedResult<ExpenseDTO>>;
  findById(id: string): Promise<ExpenseDTO | null>;
  create(input: CreateExpenseInput): Promise<ExpenseDTO>;
  cancel(id: string, expectedVersion: number): Promise<void>;
}

export interface IExpenseNamesRepository {
  list(): Promise<string[]>;
  add(name: string): Promise<void>;
}
