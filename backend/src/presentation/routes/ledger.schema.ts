import { z } from "zod";

export const writeLedgerEntrySchema = z.object({
  partyId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  type: z.string().min(1).max(30),
  debit: z.number().int().min(0).optional(),
  credit: z.number().int().min(0).optional(),
  currency: z.enum(["SYP", "USD", "EUR"]).optional(),
  cashImpact: z.enum(["in", "out", "none"]).optional(),
  referenceType: z.string().max(50).optional(),
  referenceId: z.string().uuid().optional(),
  referenceNumber: z.string().max(100).optional(),
  description: z.string().max(500).optional(),
});

export const writeLedgerBatchSchema = z.object({
  entries: z.array(writeLedgerEntrySchema).min(1).max(50),
});

export const listLedgerSchema = z.object({
  partyId: z.string().uuid().optional(),
  type: z.string().optional(),
  currency: z.enum(["SYP", "USD", "EUR"]).optional(),
  referenceType: z.string().optional(),
  referenceId: z.string().optional(),
  search: z.string().max(200).optional(),
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  sort: z.enum(["asc", "desc"]).optional().default("desc"),
  page: z.coerce.number().int().min(0).optional().default(0),
  limit: z.coerce.number().int().min(1).max(1000).optional().default(20),
});

export const cancelLedgerByReferenceSchema = z.object({
  referenceType: z.string().min(1),
  referenceId: z.string().uuid(),
});
