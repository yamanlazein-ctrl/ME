import { z } from "zod";
import { exchangeRateSchema } from "@erp/shared";

export const statementQuerySchema = z.object({
  from: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  to: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  /** `"ALL"` returns every ledger currency (running balance is per-currency). */
  currency: z.enum(["SYP", "USD", "EUR", "ALL"]).optional(),
  type: z.string().max(30).optional(),
});

export const settlePartySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  currency: z.enum(["SYP", "USD", "EUR"]).optional(),
  notesInternal: z.string().max(500).optional(),
});

/** Multi-invoice cash settlement (سند تسوية مجمّع). */
export const settleInvoicesSchema = z.object({
  invoiceIds: z.array(z.string().uuid()).min(1).max(200),
  amountPaid: z.number().positive().finite(),
  currency: z.enum(["SYP", "USD", "EUR"]),
  exchangeRate: exchangeRateSchema,
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  method: z.enum(["cash", "transfer", "check", "card"]).optional(),
  notesInternal: z.string().max(500).optional(),
  notesPrint: z.string().max(500).optional(),
});
