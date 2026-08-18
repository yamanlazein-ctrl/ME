import { z } from "zod";
import { is2dp, MAX_2DP_MESSAGE } from "./precision.js";

export const createPrintJobSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  sourceRollId: z.string().uuid(),
  sourceFabricId: z.string().uuid().optional(),
  sourceColorId: z.string().uuid().optional(),
  quantityKg: z
    .number()
    .positive()
    .max(100000)
    .refine(is2dp, { message: MAX_2DP_MESSAGE }),
  pressName: z.string().max(255).optional(),
  printCostPerKg: z.number().positive().optional(),
  currency: z.enum(["SYP", "USD", "EUR"]).optional(),
  newName: z.string().max(255).optional(),
  newCategory: z.string().max(100).optional(),
  newColorName: z.string().max(255).optional(),
  newColorCode: z.string().max(50).optional(),
  newSalePricePerKg: z.number().positive().optional(),
  notes: z.string().max(2000).optional(),
  customerId: z.string().uuid().optional(),
  orderId: z.string().uuid().optional(),
  chargePerKg: z.number().positive().optional(),
});

export const receivePrintJobSchema = z.object({
  jobId: z.string().uuid(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  receivedKg: z
    .number()
    .positive()
    .max(100000)
    .refine(is2dp, { message: MAX_2DP_MESSAGE }),
  printCostPerKg: z.number().positive().optional(),
  currency: z.enum(["SYP", "USD", "EUR"]).optional(),
  newName: z.string().max(255).optional(),
  newCategory: z.string().max(100).optional(),
  newColorName: z.string().max(255).optional(),
  newColorCode: z.string().max(50).optional(),
  newSalePricePerKg: z.number().positive().optional(),
  notes: z.string().max(2000).optional(),
});