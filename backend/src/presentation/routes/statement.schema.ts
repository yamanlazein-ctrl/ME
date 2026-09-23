import { z } from "zod";
import { exchangeRateSchema, requireFxRate, FX_REQUIRED_MESSAGE } from "@erp/shared";

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
  /** Page size (clamped server-side to 500). Default 200. */
  limit: z.coerce.number().int().min(1).max(500).optional(),
  /** Opaque cursor from previous page (`date|createdAtIso|id`). */
  cursor: z.string().max(200).optional(),
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
export const settleInvoicesSchema = z
  .object({
    invoiceIds: z.array(z.string().uuid()).min(1).max(200),
    amountPaid: z.number().min(0).finite(),
    /** Settlement adjustment (مسامحة / خصم مكتسب). Party reduction = amountPaid + discount. */
    discount: z.number().min(0).finite().optional(),
    currency: z.enum(["SYP", "USD", "EUR"]),
    exchangeRate: exchangeRateSchema,
    date: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    method: z.enum(["cash", "transfer", "check", "card"]).optional(),
    notesInternal: z.string().max(500).optional(),
    notesPrint: z.string().max(500).optional(),
  })
  .superRefine((val, ctx) => {
    if ((val.amountPaid ?? 0) + (val.discount ?? 0) <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["amountPaid"],
        message: "يجب أن يكون مجموع المبلغ النقدي والمسامحة أكبر من صفر",
      });
    }
    // DFP-034: non-USD settlements must carry an explicit rate (never silent FX).
    if (!requireFxRate(val.currency, val.exchangeRate)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["exchangeRate"],
        message: FX_REQUIRED_MESSAGE,
      });
    }
  });
