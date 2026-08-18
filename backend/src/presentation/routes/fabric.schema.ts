import { z } from "zod";

export const createFabricSchema = z.object({
  name: z.string().min(1).max(255),
  category: z.string().max(100).optional(),
  minStockKg: z.number().min(0).optional(),
  unit: z.string().max(10).optional(),
  notes: z.string().max(2000).optional(),
  imageUrl: z.string().max(2_000_000).optional(),
});

export const updateFabricSchema = createFabricSchema.partial();

export const listFabricsSchema = z.object({
  search: z.string().max(200).optional(),
  page: z.coerce.number().int().min(0).optional().default(0),
  limit: z.coerce.number().int().min(1).max(1000).optional().default(20),
});

export type CreateFabricInput = z.infer<typeof createFabricSchema>;
