import { z } from "zod";

export const createVoucherSchema = z.object({
  kind: z.enum(["receipt", "payment"]),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  partyId: z.string().uuid(),
  partyKind: z.enum(["customer", "supplier"]),
  invoiceId: z.string().uuid().optional(),
  amount: z.number().int().positive(),
  currency: z.enum(["SYP", "USD", "EUR"]).optional(),
  method: z.enum(["cash", "transfer", "check", "card"]),
  notesPrint: z.string().max(2000).optional(),
  notesInternal: z.string().max(2000).optional(),
});

export const listVouchersSchema = z.object({
  kind: z.enum(["receipt", "payment"]).optional(),
  partyId: z.string().uuid().optional(),
  invoiceId: z.string().uuid().optional(),
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

export type CreateVoucherInput = z.infer<typeof createVoucherSchema>;
