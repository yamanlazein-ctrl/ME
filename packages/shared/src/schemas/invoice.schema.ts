import { z } from "zod";
import { is2dp, MAX_2DP_MESSAGE, round2dp } from "../precision.js";
import { exchangeRateSchema } from "../fx.js";

const invoiceLineSchema = z.object({
  fabricId: z.string().uuid(),
  colorId: z.string().uuid(),
  rollId: z.string().uuid(),
  quantityKg: z.coerce
    .number()
    .positive("الكمية يجب أن تكون أكبر من صفر")
    .max(100000, "الكمية كبيرة جداً")
    .refine(is2dp, { message: MAX_2DP_MESSAGE }),
  pieces: z.coerce.number().int().positive().max(100000).optional().default(1),
  pricePerKg: z.coerce
    .number()
    .positive("السعر يجب أن يكون أكبر من صفر")
    .refine(is2dp, { message: MAX_2DP_MESSAGE }),
  discountAmount: z.coerce.number().min(0, "الخصم لا يمكن أن يكون سالباً").optional(),
  note: z.string().max(500).optional(),
});

export const createInvoiceSchema = z
  .object({
    type: z.enum(["entry", "sale"]),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    partyId: z.string().uuid(),
   partyType: z.enum(["customer", "supplier"]),
   // Human-readable reference (ENT-2026-0001 / INV-2026-0001). Optional —
   // the server falls back to its generated number when omitted.
   reference: z.string().max(100).optional(),
    currency: z.enum(["SYP", "USD", "EUR"]).optional(),
    // BUG-03 fix: frozen FX rate (units of `currency` per 1 USD). Required
    // semantics: forced to 1 for USD; optional-but-honored for non-USD.
    exchangeRate: exchangeRateSchema,
    lines: z.array(invoiceLineSchema).min(1).max(100),
    discount: z.number().min(0, "الخصم لا يمكن أن يكون سالباً").optional(),
    tax: z.number().min(0, "الضريبة لا يمكن أن تكون سالبة").optional(),
    shipping: z.number().min(0, "الشحن لا يمكن أن يكون سالباً").optional(),
    notes: z.string().max(2000).optional(),
    paid: z.number().min(0, "المبلغ المدفوع لا يمكن أن يكون سالباً").optional(),
    paymentMethod: z.enum(["cash", "transfer", "check", "card"]).optional(),
    orderId: z.string().uuid().optional(),
  })
  .superRefine((data, ctx) => {
    // 2dp per-line rounding + one edge round on the sum — mirrors
    // packages/shared/src/entities/Invoice.ts computeSubtotal exactly.
    const subtotal = round2dp(
      data.lines.reduce(
        (s, l) => s + Math.max(0, round2dp(Number(l.quantityKg) * Number(l.pricePerKg) - Number(l.discountAmount ?? 0))),
        0,
      ),
    );
    const discount = data.discount ?? 0;
    if (discount > subtotal) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["discount"], message: "الخصم لا يمكن أن يتجاوز المجموع الفرعي" });
    }
    const total = subtotal - discount + (data.tax ?? 0) + (data.shipping ?? 0);
    if (total <= 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["discount"], message: "مجموع الفاتورة يجب أن يكون موجباً" });
    }
    if ((data.paid ?? 0) > total) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["paid"], message: "المبلغ المدفوع لا يمكن أن يتجاوز الإجمالي" });
    }
  });

export const updateInvoiceSchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    lines: z.array(invoiceLineSchema).min(1).max(100),
    // FX re-capture on edit (mirrors create): optional strictly-positive rate.
    // Omitted → the repository falls back to the frozen rate already stored on
    // the invoice (USD is always 1). Never silently re-values a historical doc.
    exchangeRate: exchangeRateSchema,
    discount: z.number().min(0, "الخصم لا يمكن أن يكون سالباً").optional(),
    tax: z.number().min(0, "الضريبة لا يمكن أن تكون سالبة").optional(),
    shipping: z.number().min(0, "الشحن لا يمكن أن يكون سالباً").optional(),
    notes: z.string().max(2000).optional(),
  })
  .superRefine((data, ctx) => {
    const subtotal = round2dp(
      data.lines.reduce(
        (s, l) => s + Math.max(0, round2dp(Number(l.quantityKg) * Number(l.pricePerKg) - Number(l.discountAmount ?? 0))),
        0,
      ),
    );
    const discount = data.discount ?? 0;
    if (discount > subtotal) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["discount"], message: "الخصم لا يمكن أن يتجاوز المجموع الفرعي" });
    }
    const total = subtotal - discount + (data.tax ?? 0) + (data.shipping ?? 0);
    if (total <= 0) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["discount"], message: "مجموع الفاتورة يجب أن يكون موجباً" });
    }
  });

export const listInvoicesSchema = z.object({
  partyId: z.string().uuid().optional(),
  type: z.enum(["entry", "sale"]).optional(),
  status: z.enum(["active", "cancelled"]).optional(),
  fromDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  toDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  search: z.string().max(200).optional(),
  page: z.coerce.number().int().min(0).optional().default(0),
  limit: z.coerce.number().int().min(1).max(1000).optional().default(20),
});

export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;
export type InvoiceLineInput = z.infer<typeof invoiceLineSchema>;

