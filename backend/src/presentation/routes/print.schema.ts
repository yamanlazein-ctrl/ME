import { z } from "zod";
import { exchangeRateSchema } from "@erp/shared";
import { is2dp, MAX_2DP_MESSAGE } from "./precision.js";

export const createPrintJobSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  sourceRollId: z.string().uuid(),
  sourceFabricId: z.string().uuid().optional(),
  sourceColorId: z.string().uuid().optional(),
  quantityKg: z.number().positive().max(100000).refine(is2dp, { message: MAX_2DP_MESSAGE }),
  pieces: z.coerce.number().int().positive().max(100000).optional(),
  pressName: z.string().max(255).optional(),
  printCostPerKg: z.number().min(0).optional(),
  currency: z.enum(["SYP", "USD", "EUR"]).optional(),
  exchangeRate: exchangeRateSchema,
  newName: z.string().max(255).optional(),
  newCategory: z.string().max(100).optional(),
  newColorName: z.string().max(255).optional(),
  newColorCode: z.string().max(50).optional(),
  newSalePricePerKg: z.number().min(0).optional(),
  notes: z.string().max(2000).optional(),
  customerId: z.string().uuid().optional(),
  orderId: z.string().uuid().optional(),
  chargePerKg: z.number().min(0).optional(),
});

export const receivePrintJobSchema = z.object({
  jobId: z.string().uuid(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  receivedKg: z.number().positive().max(100000).refine(is2dp, { message: MAX_2DP_MESSAGE }),
  printCostPerKg: z.number().min(0).optional(),
  currency: z.enum(["SYP", "USD", "EUR"]).optional(),
  exchangeRate: exchangeRateSchema,
  newName: z.string().max(255).optional(),
  newCategory: z.string().max(100).optional(),
  newColorName: z.string().max(255).optional(),
  newColorCode: z.string().max(50).optional(),
  newColorHex: z
    .preprocess(
      (v) => (v === "" || v === null ? undefined : v),
      z
        .string()
        .regex(/^#([0-9A-Fa-f]{3}|[0-9A-Fa-f]{6}|[0-9A-Fa-f]{8})$/, "لون غير صالح")
        .optional(),
    ),
  newSalePricePerKg: z.number().min(0).optional(),
  notes: z.string().max(2000).optional(),
});
