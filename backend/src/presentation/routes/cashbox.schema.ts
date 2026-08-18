import { z } from "zod";

export const setOpeningBalanceSchema = z.object({
  openingBalance: z.number().int().min(0),
  openingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  currency: z.enum(["SYP", "USD", "EUR"]).optional(),
});

export const addManualMovementSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  type: z.enum(["capital", "withdrawal", "transfer", "adjustment", "correction"]),
  direction: z.enum(["in", "out"]),
  amount: z.number().int().positive(),
  currency: z.enum(["SYP", "USD", "EUR"]).optional(),
  description: z.string().max(500).optional(),
  notesInternal: z.string().max(500).optional(),
});

export const closeDaySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  openingBalance: z.number().int().min(0),
  totalIn: z.number().int().min(0),
  totalOut: z.number().int().min(0),
  counted: z.number().int().min(0),
  currency: z.enum(["SYP", "USD", "EUR"]).optional(),
});
