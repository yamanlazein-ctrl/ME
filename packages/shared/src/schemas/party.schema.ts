import { z } from "zod";
import { is2dp, MAX_2DP_MESSAGE } from "../precision.js";

/** UI direction for opening balance — server maps to signed openingBalance by kind. */
export const openingDirectionSchema = z.enum(["they_owe_us", "we_owe_them"]);
export type OpeningDirection = z.infer<typeof openingDirectionSchema>;

const isoDateSchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, "تاريخ الرصيد الافتتاحي يجب أن يكون بصيغة YYYY-MM-DD");

export const createPartySchema = z.object({
  kind: z.enum(["customer", "supplier"]),
  code: z.string().max(50).optional(),
  name: z.string().min(1).max(255),
  companyName: z.string().max(255).optional(),
  commercialReg: z.string().max(100).optional(),
  category: z.string().max(100).optional(),
  salesRep: z.string().max(100).optional(),
  phone: z.string().max(30).optional(),
  mobile: z.string().max(30).optional(),
  whatsapp: z.string().max(30).optional(),
  altPhone: z.string().max(30).optional(),
  // Optional. Blank/whitespace counts as "not provided"; stray spaces are trimmed.
  // Anything else must be a real email — with a readable Arabic message (the
  // default "Invalid email" leaked to users when a form field held a name/phone).
  email: z.preprocess((v) => {
    if (v === null) return undefined;
    if (typeof v !== "string") return v;
    const t = v.trim();
    return t === "" ? undefined : t;
  }, z.string().email("صيغة البريد الإلكتروني غير صحيحة").max(320).optional()),
  website: z.string().max(500).optional(),
  address: z.string().optional(),
  city: z.string().max(100).optional(),
  country: z.string().max(100).optional(),
  taxNumber: z.string().max(100).optional(),
  /** Signed SoT amount (API/sync). Positive convention: customer AR / supplier AP. */
  openingBalance: z.number().refine(is2dp, { message: MAX_2DP_MESSAGE }).optional(),
  /** Absolute amount from UI; wins over openingBalance when paired with openingDirection. */
  openingAmount: z.number().min(0).refine(is2dp, { message: MAX_2DP_MESSAGE }).optional(),
  openingDirection: openingDirectionSchema.optional(),
  openingDate: isoDateSchema.optional(),
  openingNote: z.string().max(500).optional(),
  /** Currency of the opening journal; defaults to the party's currency. */
  openingCurrency: z.enum(["SYP", "USD"]).optional(),
  creditLimit: z.number().refine(is2dp, { message: MAX_2DP_MESSAGE }).optional(),
  currency: z.enum(["SYP", "USD", "EUR"]).optional(),
  paymentTerms: z.string().max(20).optional(),
  paymentMethod: z.string().max(20).optional(),
  defaultDiscount: z.number().min(0).optional(),
  // Stored as a fraction (0.16 = 16%). Values > 1 overflow decimal(5,4).
  vat: z
    .number()
    .min(0, "نسبة الضريبة لا يمكن أن تكون سالبة")
    .max(1, "نسبة الضريبة يجب أن تكون كسراً بين 0 و 1 (مثال: 0.16 لـ 16٪)")
    .optional(),
  notes: z.string().max(2000).optional(),
  status: z.enum(["active", "inactive"]).optional(),
});

export const updatePartySchema = createPartySchema.partial().omit({ kind: true });

/** Replace a party's opening balance (old journal cancelled, new one posted). */
export const partyOpeningSchema = z.object({
  amount: z.number().min(0).refine(is2dp, { message: MAX_2DP_MESSAGE }),
  direction: openingDirectionSchema,
  currency: z.enum(["SYP", "USD"]),
  date: isoDateSchema,
  note: z.string().max(500).nullish(),
});
export const setPartyOpeningSchema = z.object({ opening: partyOpeningSchema });
export type PartyOpeningInput = z.infer<typeof partyOpeningSchema>;

export const listPartiesSchema = z.object({
  /** Keyset cursor for "load every row" callers (no OFFSET scan). */
  cursor: z.string().max(300).optional(),
  kind: z.enum(["customer", "supplier"]).optional(),
  search: z.string().max(200).optional(),
  status: z.enum(["active", "inactive", "cancelled"]).optional(),
  page: z.coerce.number().int().min(0).optional().default(0),
  limit: z.coerce.number().int().min(1).max(1000).optional().default(20),
});

export type CreatePartyInput = z.infer<typeof createPartySchema>;
export type UpdatePartyInput = z.infer<typeof updatePartySchema>;
export type ListPartiesInput = z.infer<typeof listPartiesSchema>;
