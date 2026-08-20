export type RollData = {
  id: string;
  tenantId: string;
  colorId: string;
  rollNo: string;
  dyeBatch?: string | null;
  initialKg: number;
  remainingKg: number;
  pieces: number;
  pricePerKg: number;
  salePricePerKg?: number | null;
  currency: string;
  supplierId?: string | null;
  entryDate: string;
  widthCm?: number | null;
  weightGsm?: number | null;
  status: "in_stock" | "exhausted";
  version: number;
  createdAt: string;
  updatedAt?: string;
};

export function createRollData(input: {
  colorId: string;
  rollNo: string;
  dyeBatch?: string;
  initialKg: number;
  pricePerKg: number;
  salePricePerKg?: number;
  currency?: string;
  supplierId?: string;
  entryDate: string;
  pieces?: number;
  widthCm?: number;
  weightGsm?: number;
}): Omit<RollData, "id" | "tenantId" | "remainingKg" | "version" | "createdAt" | "status"> & Partial<RollData> {
  return {
    colorId: input.colorId,
    rollNo: input.rollNo.trim(),
    dyeBatch: input.dyeBatch?.trim() ?? null,
    initialKg: Math.max(0, input.initialKg),
    pieces: input.pieces ?? 1,
    pricePerKg: input.pricePerKg,
    salePricePerKg: input.salePricePerKg ?? null,
    currency: input.currency ?? "SYP",
    supplierId: input.supplierId ?? null,
    entryDate: input.entryDate,
    widthCm: input.widthCm ?? null,
    weightGsm: input.weightGsm ?? null,
  } as unknown as RollData;
}

export function reserveStock(data: RollData, kg: number): void {
  if (kg <= 0) throw new Error("reserve() requires positive kg");
  if (data.remainingKg < kg) throw new Error(`Insufficient stock: requested ${kg}, available ${data.remainingKg} on roll ${data.rollNo}`);
  data.remainingKg = Math.round((data.remainingKg - kg) * 100) / 100;
  data.version += 1;
  if (data.remainingKg === 0) data.status = "exhausted";
}

export function releaseStock(data: RollData, kg: number): void {
  if (kg <= 0) return;
  const next = Math.round((data.remainingKg + kg) * 100) / 100;
  if (next > data.initialKg) {
    data.remainingKg = data.initialKg;
  } else {
    data.remainingKg = next;
  }
  data.version += 1;
  if (data.remainingKg > 0 && data.status === "exhausted") data.status = "in_stock";
}

export function isOutOfStock(data: RollData): boolean {
  return data.remainingKg <= 0;
}
