import { z } from "zod";

/**
 * Query schema for profit endpoints.
 * fromDate/toDate are optional — when omitted, the query covers all time.
 * currency is optional — when omitted, ALL currencies are returned (each
 * in its own bucket, never mixed).
 */
export const profitQuerySchema = z.object({
  fromDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  toDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  currency: z.enum(["SYP", "USD", "EUR"]).optional(),
});

export type ProfitQueryRequest = z.infer<typeof profitQuerySchema>;
