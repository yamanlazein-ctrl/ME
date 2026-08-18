import { z } from "zod";
import { is2dp, MAX_2DP_MESSAGE } from "./precision.js";

const returnLineSchema = z.object({
  rollId: z.string().uuid(),
  quantityKg: z
    .number()
    .positive()
    .max(100000)
    .refine(is2dp, { message: MAX_2DP_MESSAGE }),
  pieces: z.coerce.number().int().positive().max(100000).optional().default(1),
  pricePerKg: z
    .number()
    .positive()
    .refine(is2dp, { message: MAX_2DP_MESSAGE }),
});

export const createReturnSchema = z.object({
  kind: z.enum(["entry", "sale"]),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  partyId: z.string().uuid(),
  originalInvoiceId: z.string().uuid().optional(),
  reason: z.enum(["defect", "wrong_quantity", "wrong_order", "other"]),
  currency: z.enum(["SYP", "USD", "EUR"]).optional(),
  notesPrint: z.string().max(2000).optional(),
  notesInternal: z.string().max(2000).optional(),
  lines: z.array(returnLineSchema).min(1).max(100),
});

export const listReturnsSchema = z.object({
  kind: z.enum(["entry", "sale"]).optional(),
  partyId: z.string().uuid().optional(),
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

export type CreateReturnInput = z.infer<typeof createReturnSchema>;
