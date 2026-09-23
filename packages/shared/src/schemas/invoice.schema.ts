import { z } from "zod";
import { is2dp, MAX_2DP_MESSAGE, round2dp } from "../precision.js";
import { exchangeRateSchema } from "../fx.js";
import { computeSubtotal, invoiceTotal, type InvoiceLineData } from "../entities/Invoice.js";

/**
 * FIN-01: the money formula has exactly one executed implementation
 * (entities/Invoice.ts). Schema refinements adapt their input to it instead of
 * re-deriving it, so a formula change cannot drift between layers.
 */
function linesForMath(
  lines: ReadonlyArray<{ quantityKg: unknown; pricePerKg: unknown; discountAmount?: unknown }>,
): InvoiceLineData[] {
  return lines.map(
    (l) =>
      ({
        quantityKg: Number(l.quantityKg),
        pricePerKg: Number(l.pricePerKg),
        discountAmount: Number(l.discountAmount ?? 0),
      }) as InvoiceLineData,
  );
}

const invoiceLineSchema = z.object({
  fabricId: z.string().uuid(),
  colorId: z.string().uuid(),
  rollId: z.string().uuid(),
  quantityKg: z.coerce
    .number()
    .positive("الكمية يجب أن تكون أكبر من صفر")
    .max(100000, "الكمية كبيرة جداً")
    .refine(is2dp, { message: MAX_2DP_MESSAGE }),
  // 0 is valid: a roll can be down to loose remnant kg with no whole pieces
  // left (remainingPieces === 0, remainingKg > 0) — that stock must still be
  // sellable by weight without requesting a piece the roll no longer has.
  // Existing callers that omit `pieces` keep requesting 1 whole piece (the
  // default is unchanged), so normal piece-based sales are unaffected.
  pieces: z.coerce.number().int().min(0).max(100000).optional().default(1),
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
    // Sale invoices: part of the total settled from the customer's existing
    // credit balance (advance payments / earlier overpayments). The server
    // re-validates it against the live ledger.
    creditApplied: z
      .number()
      .min(0, "المبلغ المخصوم من الرصيد لا يمكن أن يكون سالباً")
      .refine(is2dp, { message: MAX_2DP_MESSAGE })
      .optional(),
    orderId: z.string().uuid().optional(),
  })
  .superRefine((data, ctx) => {
    const mathLines = linesForMath(data.lines);
    const subtotal = computeSubtotal(mathLines);
    const discount = data.discount ?? 0;
    if (discount > subtotal) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["discount"],
        message: "الخصم لا يمكن أن يتجاوز المجموع الفرعي",
      });
    }
    const total = invoiceTotal({
      lines: mathLines,
      discount,
      tax: data.tax ?? 0,
      shipping: data.shipping ?? 0,
    });
    if (total <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["discount"],
        message: "مجموع الفاتورة يجب أن يكون موجباً",
      });
    }
    // A customer paying MORE than a sale invoice is accepted: the invoice is
    // settled and the excess becomes customer credit. Purchase invoices keep
    // the strict rule (supplier advances go through a standalone payment).
    if (data.type !== "sale" && (data.paid ?? 0) > total) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["paid"],
        message: "المبلغ المدفوع لا يمكن أن يتجاوز الإجمالي",
      });
    }
    if ((data.creditApplied ?? 0) > 0) {
      if (data.type !== "sale") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["creditApplied"],
          message: "الخصم من الرصيد الدائن متاح لفواتير البيع فقط",
        });
      } else if (Math.min(data.paid ?? 0, total) + (data.creditApplied ?? 0) > total + 0.01) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["creditApplied"],
          message: "المدفوع مع المخصوم من الرصيد يتجاوز إجمالي الفاتورة",
        });
      }
    }
  });

export const updateInvoiceSchema = z
  .object({
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
    lines: z.array(invoiceLineSchema).min(1).max(100),
    // Optional exchangeRate on edit is accepted only when it matches the
    // frozen create-time rate (or is omitted). The repository rejects a
    // different rate so historical docs are never revalued via FX rewrite.
    exchangeRate: exchangeRateSchema,
    discount: z.number().min(0, "الخصم لا يمكن أن يكون سالباً").optional(),
    tax: z.number().min(0, "الضريبة لا يمكن أن تكون سالبة").optional(),
    shipping: z.number().min(0, "الشحن لا يمكن أن يكون سالباً").optional(),
    notes: z.string().max(2000).optional(),
  })
  .superRefine((data, ctx) => {
    const mathLines = linesForMath(data.lines);
    const subtotal = computeSubtotal(mathLines);
    const discount = data.discount ?? 0;
    if (discount > subtotal) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["discount"],
        message: "الخصم لا يمكن أن يتجاوز المجموع الفرعي",
      });
    }
    const total = invoiceTotal({
      lines: mathLines,
      discount,
      tax: data.tax ?? 0,
      shipping: data.shipping ?? 0,
    });
    if (total <= 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["discount"],
        message: "مجموع الفاتورة يجب أن يكون موجباً",
      });
    }
  });

export const listInvoicesSchema = z.object({
  partyId: z.string().uuid().optional(),
  type: z.enum(["entry", "sale"]).optional(),
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

export type CreateInvoiceInput = z.infer<typeof createInvoiceSchema>;
export type InvoiceLineInput = z.infer<typeof invoiceLineSchema>;
