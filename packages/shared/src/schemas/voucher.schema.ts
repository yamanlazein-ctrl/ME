import { z } from "zod";
import { exchangeRateSchema } from "../fx.js";
import { is2dp, MAX_2DP_MESSAGE } from "../precision.js";

export const createVoucherSchema = z
  .object({
    kind: z.enum(["receipt", "payment"]),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    partyId: z.string().uuid(),
    partyKind: z.enum(["customer", "supplier"]),
    invoiceId: z.string().uuid().optional(),
    /** Actual cash that moves. Discount is added on top — never subtracted. */
    amount: z.number().min(0).refine(is2dp, { message: MAX_2DP_MESSAGE }),
    /** Settlement adjustment (مسامحة / خصم مكتسب). Party reduction = amount + discount. */
    discount: z.number().min(0).refine(is2dp, { message: MAX_2DP_MESSAGE }).optional().default(0),
    currency: z.enum(["SYP", "USD", "EUR"]).optional(),
    // BUG-03 (same-pattern) frozen FX rate: units of `currency` per 1 USD,
    // required for non-USD vouchers. Mirrors createInvoiceSchema.
    exchangeRate: exchangeRateSchema,
    method: z.enum(["cash", "transfer", "check", "card"]),
    notesPrint: z.string().max(2000).optional(),
    notesInternal: z.string().max(2000).optional(),
  })
  .superRefine((data, ctx) => {
    const discount = data.discount ?? 0;
    if (data.amount + discount <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "يجب أن يكون مجموع المبلغ النقدي والمسامحة أكبر من صفر",
        path: ["amount"],
      });
    }
  });

export const listVouchersSchema = z.object({
  /** Keyset cursor for "load every row" callers (no OFFSET scan). */
  cursor: z.string().max(300).optional(),
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
