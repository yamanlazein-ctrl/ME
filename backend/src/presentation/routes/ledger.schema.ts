import { z } from "zod";
import { is2dp, MAX_2DP_MESSAGE } from "@erp/shared";

export const writeLedgerEntrySchema = z.object({
  partyId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  type: z.string().min(1).max(30),
  debit: z.number().min(0).refine(is2dp, { message: MAX_2DP_MESSAGE }).optional(),
  credit: z.number().min(0).refine(is2dp, { message: MAX_2DP_MESSAGE }).optional(),
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
  /** Keyset cursor for "load every row" callers (no OFFSET scan). */
  cursor: z.string().max(300).optional(),
  partyId: z.string().uuid().optional(),
  type: z.string().optional(),
  currency: z.enum(["SYP", "USD", "EUR"]).optional(),
  referenceType: z.string().optional(),
  referenceId: z.string().optional(),
  search: z.string().max(200).optional(),
  fromDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  toDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  status: z.enum(["active", "cancelled", "all"]).optional(),
  keepOpening: z
    .enum(["1", "0", "true", "false"])
    .optional()
    .transform((v) => v === "1" || v === "true"),
  sort: z.enum(["asc", "desc"]).optional().default("desc"),
  page: z.coerce.number().int().min(0).optional().default(0),
  limit: z.coerce.number().int().min(1).max(1000).optional().default(20),
});

export const cancelLedgerByReferenceSchema = z.object({
  referenceType: z.string().min(1),
  referenceId: z.string().uuid(),
});
