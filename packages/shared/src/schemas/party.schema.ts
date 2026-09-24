import { z } from "zod";
import { is2dp, MAX_2DP_MESSAGE } from "../precision.js";

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
  openingBalance: z.number().refine(is2dp, { message: MAX_2DP_MESSAGE }).optional(),
  creditLimit: z.number().refine(is2dp, { message: MAX_2DP_MESSAGE }).optional(),
  currency: z.enum(["SYP", "USD", "EUR"]).optional(),
  paymentTerms: z.string().max(20).optional(),
  paymentMethod: z.string().max(20).optional(),
  defaultDiscount: z.number().min(0).optional(),
  vat: z.number().min(0).optional(),
  notes: z.string().max(2000).optional(),
  status: z.enum(["active", "inactive"]).optional(),
});

export const updatePartySchema = createPartySchema.partial().omit({ kind: true });

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
