export type FabricData = {
  id: string;
  tenantId: string;
  name: string;
  category?: string | null;
  minStockKg: number | null;
  notes?: string | null;
  unit?: string | null;
  imageUrl?: string | null;
  createdBy?: string | null;
  createdAt: string;
};

export function createFabricData(input: {
  name: string;
  tenantId?: string;
  category?: string;
  minStockKg?: number | null;
  notes?: string;
  unit?: string;
  imageUrl?: string;
  createdBy?: string | null;
}): Omit<FabricData, "id" | "createdAt"> & Pick<FabricData, "id" | "createdAt"> {
  if (!input.name?.trim()) throw new Error("Fabric name is required.");
  return {
    id: crypto.randomUUID(),
    tenantId: input.tenantId ?? "",
    name: input.name.trim(),
    category: input.category?.trim() ?? null,
    minStockKg: input.minStockKg ?? null,
    notes: input.notes?.trim() ?? null,
    unit: (input.unit?.trim() as FabricData["unit"]) ?? "kg",
    imageUrl: input.imageUrl?.trim() ?? null,
    createdBy: input.createdBy ?? null,
    createdAt: new Date().toISOString(),
  } as FabricData;
}
