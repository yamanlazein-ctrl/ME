import type { FabricUnit, Color } from "@/presentation/hooks/useInventory";

export type EntryLine = {
  id: string;
  existingFabricId?: string;
  existingColorId?: string;
  fabricName: string;
  category: string;
  unit: FabricUnit;
  colorName: string;
  colorCode: string;
  colorHex?: string;
  colorImageUrl?: string;
  dyeBatch: string;
  widthCm?: number;
  weightGsm?: number;
  grossKg: number;
  quantity: number;
  pricePerKg: number;
  discountAmount: number;
  salePricePerKg?: number;
  marjaiya: string;
  masader: string;
  machineNumber: string;
  kromaj: string;
  gsm: string;
  adad: string;
  sahb: string;
  pieces: number;
  notes?: string;
  imageUrl?: string;
};

let lineSeq = 0;
export const emptyLine = (): EntryLine => ({
  id: `l-${++lineSeq}`,
  fabricName: "",
  category: "",
  unit: "kg",
  colorName: "",
  colorCode: "",
  dyeBatch: "",
  grossKg: 0,
  quantity: 0,
  pricePerKg: 0,
  discountAmount: 0,
  marjaiya: "",
  masader: "",
  machineNumber: "",
  kromaj: "",
  gsm: "",
  adad: "",
  sahb: "",
  pieces: 1,
});

export const cloneStickyFields = (prev: EntryLine): Partial<EntryLine> => ({
  existingFabricId: prev.existingFabricId,
  existingColorId: prev.existingColorId,
  fabricName: prev.fabricName,
  category: prev.category,
  unit: prev.unit,
  colorName: prev.colorName,
  colorCode: prev.colorCode,
  widthCm: prev.widthCm,
  weightGsm: prev.weightGsm,
  pricePerKg: prev.pricePerKg,
  discountAmount: prev.discountAmount,
  marjaiya: prev.marjaiya,
  masader: prev.masader,
  machineNumber: prev.machineNumber,
  kromaj: prev.kromaj,
  gsm: prev.gsm,
  pieces: prev.pieces,
});

export const lineHasData = (l: EntryLine) =>
  l.fabricName.trim() !== "" || l.quantity > 0 || l.pricePerKg > 0;

export const lineSubtotal = (l: EntryLine) => {
  const gross = (l.quantity || 0) * (l.pricePerKg || 0);
  // Fixed-amount (not percentage) line discount, floored at zero.
  return Math.max(0, gross - (l.discountAmount || 0));
};

export const pickExistingFabric = (
  fabricId: string,
  f: { id: string; name: string; category?: string | null; unit?: string | null },
): Partial<EntryLine> => ({
  existingFabricId: f.id,
  fabricName: f.name,
  category: f.category ?? "",
  unit: (f.unit ?? "kg") as FabricUnit,
  existingColorId: undefined,
  colorName: "",
  colorCode: "",
  colorHex: undefined,
});

export const pickExistingColor = (c: Color): Partial<EntryLine> => ({
  existingColorId: c.id,
  colorName: c.name,
  colorCode: c.code,
  colorHex: c.hex ?? undefined,
  colorImageUrl: c.imageUrl ?? undefined,
});
