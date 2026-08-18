import { z } from "zod";

export const createExpenseSchema = z.object({
  category: z.string().min(1).max(100),
  description: z.string().min(1).max(500),
  amount: z.number().int().positive(),
  currency: z.enum(["SYP", "USD", "EUR"]).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  method: z.enum(["cash", "transfer", "check", "card"]),
  paidFromCashbox: z.boolean().optional(),
  notesPrint: z.string().max(2000).optional(),
  notesInternal: z.string().max(2000).optional(),
});

export const addExpenseNameSchema = z.object({
  name: z.string().min(1).max(100),
});

export const listExpensesSchema = z.object({
  category: z.string().optional(),
  status: z.enum(["active", "cancelled"]).optional(),
  fromDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  toDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  search: z.string().max(200).optional(),
  page: z.coerce.number().int().min(0).optional().default(0),
  limit: z.coerce.number().int().min(1).max(1000).optional().default(20),
});
