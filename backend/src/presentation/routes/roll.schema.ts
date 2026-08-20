import { z } from "zod";
import { is2dp, MAX_2DP_MESSAGE } from "./precision.js";

export const createRollSchema = z.object({
  colorId: z.string().uuid(),
  rollNo: z.string().min(1).max(100),
  dyeBatch: z.string().max(100).optional(),
  initialKg: z.number().positive().max(100000).refine(is2dp, { message: MAX_2DP_MESSAGE }),
  /** Optional — defaults to initialKg. Entry-invoice flows pass 0 so the
   *  invoice transaction increments remainingKg to the real stock. */
  remainingKg: z.number().min(0).max(100000).refine(is2dp, { message: MAX_2DP_MESSAGE }).optional(),
  pricePerKg: z.number().positive().refine(is2dp, { message: MAX_2DP_MESSAGE }),
  salePricePerKg: z.number().positive().optional(),
  currency: z.enum(["SYP", "USD", "EUR"]).optional(),
  supplierId: z.string().uuid().optional(),
  entryDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  widthCm: z.number().positive().optional(),
  weightGsm: z.number().positive().optional(),
});

export const updateRollSchema = createRollSchema
  .partial()
  .omit({ colorId: true })
  .extend({
    remainingKg: z.number().positive().max(100000).optional(),
    // Fix H-5: optional optimistic-concurrency token. When sent, the
    // repository enforces it with a real compare-and-swap; omitted means
    // the caller hasn't adopted it yet and gets the legacy blind-write
    // behavior, unchanged.
    expectedVersion: z.number().int().nonnegative().optional(),
  });

export const listRollsSchema = z.object({
  colorId: z.string().uuid().optional(),
  status: z.enum(["in_stock", "exhausted", "reserved"]).optional(),
  search: z.string().max(200).optional(),
  page: z.coerce.number().int().min(0).optional().default(0),
  limit: z.coerce.number().int().min(1).max(1000).optional().default(20),
});

export type CreateRollInput = z.infer<typeof createRollSchema>;
