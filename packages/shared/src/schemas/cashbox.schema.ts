import { z } from "zod";
import { is2dp, MAX_2DP_MESSAGE } from "../precision.js";

export const setOpeningBalanceSchema = z.object({
  openingBalance: z.number().min(0).refine(is2dp, { message: MAX_2DP_MESSAGE }),
  openingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  currency: z.enum(["SYP", "USD", "EUR"]).optional(),
});

export const addManualMovementSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  type: z.enum(["capital", "withdrawal", "transfer", "adjustment", "correction"]),
  direction: z.enum(["in", "out"]),
  amount: z.number().positive().refine(is2dp, { message: MAX_2DP_MESSAGE }),
  currency: z.enum(["SYP", "USD", "EUR"]).optional(),
  description: z.string().max(500).optional(),
  notesInternal: z.string().max(500).optional(),
});

export const closeDaySchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  counted: z.number().min(0).refine(is2dp, { message: MAX_2DP_MESSAGE }),
  currency: z.enum(["SYP", "USD", "EUR"]).optional(),
});
