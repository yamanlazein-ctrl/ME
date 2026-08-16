import { z } from "zod";

const orderItemSchema = z.object({
  fabricId: z.string().uuid().optional(),
  fabricName: z.string().min(1).max(255),
  colorId: z.string().uuid().optional(),
  colorName: z.string().min(1).max(255),
  colorCode: z.string().max(50).optional(),
  requestedKg: z.coerce.number().positive().max(100000),
  pieces: z.coerce.number().int().positive().max(100000).optional().default(1),
  rollId: z.string().uuid().optional(),
  widthCm: z.coerce.number().positive().optional(),
  weightGsm: z.coerce.number().positive().optional(),
  notes: z.string().max(500).optional(),
});

export const createOrderSchema = z.object({
  code: z.string().max(50).optional(),
  customerId: z.string().uuid().optional(),
  customerNameSnapshot: z.string().min(1).max(255),
  customerPhoneSnapshot: z.string().max(30).optional(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  currency: z.enum(["SYP", "USD", "EUR"]).optional(),
  notes: z.string().max(2000).optional(),
  items: z.array(orderItemSchema).min(1).max(50),
});

export const updateOrderSchema = z.object({
  notes: z.string().max(2000).optional(),
  customerNameSnapshot: z.string().min(1).max(255).optional(),
  customerPhoneSnapshot: z.string().max(30).optional(),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

export const listOrdersSchema = z.object({
  customerId: z.string().uuid().optional(),
  status: z.enum(["open", "partially_available", "available", "fulfilled", "cancelled"]).optional(),
  search: z.string().max(200).optional(),
  fromDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  toDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  page: z.coerce.number().int().min(0).optional().default(0),
  limit: z.coerce.number().int().min(1).max(1000).optional().default(20),
});

export type CreateOrderInput = z.infer<typeof createOrderSchema>;
export type UpdateOrderInput = z.infer<typeof updateOrderSchema>;
