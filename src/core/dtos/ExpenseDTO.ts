import type { Currency } from "@/domain/types";
import type { VoucherMethod } from "@/domain/entities/Voucher";

/**
 * View-safe DTO for an expense. Never leak infrastructure entity types (mock
 * `Expense`) directly into JSX — map to this shape at the presentation layer.
 */
export type ExpenseDTO = {
  id: string;
  number: string;
  category: string;
  description: string;
  amount: number;
  currency: Currency;
  date: string;
  createdAt?: string;
  method: VoucherMethod;
  paidFromCashbox: boolean;
  status: "active" | "cancelled";
  notesPrint?: string;
  notesInternal?: string;
  version?: number;
};

export type CreateExpenseInput = {
  category: string;
  description: string;
  amount: number;
  currency: Currency;
  date: string;
  method: VoucherMethod;
  paidFromCashbox: boolean;
  notesPrint?: string;
  notesInternal?: string;
};

// Keys mirror the API's listExpensesSchema — an unknown key is silently stripped there (FE-06).
export type ExpenseFilter = {
  category?: string;
  fromDate?: string;
  toDate?: string;
  /** Server-side match on number, description and name (category), across all history. */
  search?: string;
  page?: number;
  limit?: number;
  cursor?: string;
};
