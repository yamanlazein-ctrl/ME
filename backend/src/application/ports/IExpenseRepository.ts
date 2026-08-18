import type { TenantContext, PaginatedResult } from "../../domain/types/index.js";
import type { ExpenseData, CreateExpenseInput } from "../../domain/entities/Expense.js";

export interface ExpenseFilter {
  category?: string;
  status?: string;
  fromDate?: string;
  toDate?: string;
  search?: string;
  page?: number;
  limit?: number;
}

export interface IExpenseRepository {
  findById(id: string, ctx: TenantContext): Promise<ExpenseData | null>;
  list(filter: ExpenseFilter, ctx: TenantContext): Promise<PaginatedResult<ExpenseData>>;
  create(input: CreateExpenseInput, autoNumber: string, ctx: TenantContext): Promise<ExpenseData>;
  cancel(id: string, cancelledBy: string, ctx: TenantContext): Promise<ExpenseData>;
}
