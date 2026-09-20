import { lineTotal as sharedLineTotal, type InvoiceLineData } from "@erp/shared";
import type { FabricUnit, Color } from "@/presentation/hooks/useInventory";

export type EntryLine = {
  id: string;
  existingFabricId?: string;
  existingColorId?: string;
  /** Existing roll id when editing an invoice — avoids creating duplicate rolls. */
  rollId?: string;
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
  sahb: "",
  pieces: 1,
});

/** Sticky fields for a new entry row: fabric + pricing + production meta only.
 * Never copy color/roll identity — a new row is a new lot (often a new colour).
 * Copying existingColorId/colorCode caused two lines to silently share one
 * colour master; editing the second line then RENAMED the shared colour.
 */
export const cloneStickyFields = (prev: EntryLine): Partial<EntryLine> => ({
  existingFabricId: prev.existingFabricId,
  fabricName: prev.fabricName,
  category: prev.category,
  unit: prev.unit,
  widthCm: prev.widthCm,
  weightGsm: prev.weightGsm,
  pricePerKg: prev.pricePerKg,
  discountAmount: prev.discountAmount,
  salePricePerKg: prev.salePricePerKg,
  marjaiya: prev.marjaiya,
  masader: prev.masader,
  machineNumber: prev.machineNumber,
  kromaj: prev.kromaj,
  gsm: prev.gsm,
  sahb: prev.sahb,
  pieces: prev.pieces,
});

export const lineHasData = (l: EntryLine) =>
  l.fabricName.trim() !== "" || l.quantity > 0 || l.pricePerKg > 0;

// FIN-01: same 2dp money authority as the backend subtotal. Fixed-amount (not
// percentage) line discount, floored at zero.
export const lineSubtotal = (l: EntryLine) =>
  sharedLineTotal({
    quantityKg: l.quantity || 0,
    pricePerKg: l.pricePerKg || 0,
    discountAmount: l.discountAmount || 0,
  } as InvoiceLineData);

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
