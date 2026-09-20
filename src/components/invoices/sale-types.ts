import { lineTotal as sharedLineTotal, type InvoiceLineData } from "@erp/shared";

export type SaleLine = {
  id: string;
  fabricId: string;
  fabricName: string;
  colorId: string;
  colorName: string;
  colorCode: string;
  rollId: string;
  quantityKg: number;
  pricePerKg: number;
  discountAmount: number;
  pieces: number;
  note?: string;
};

let lineSeq = 0;
export const emptyLine = (): SaleLine => ({
  id: `l-${++lineSeq}`,
  fabricId: "",
  fabricName: "",
  colorId: "",
  colorName: "",
  colorCode: "",
  rollId: "",
  quantityKg: 0,
  pricePerKg: 0,
  discountAmount: 0,
  pieces: 1,
});

export const cloneStickyFields = (prev: SaleLine): Partial<SaleLine> => ({
  fabricId: prev.fabricId,
  fabricName: prev.fabricName,
  colorId: prev.colorId,
  colorName: prev.colorName,
  colorCode: prev.colorCode,
  pricePerKg: prev.pricePerKg,
  discountAmount: prev.discountAmount,
  pieces: prev.pieces,
});

/** Copy only fabric identity; clear color & roll so user picks a new color for the same fabric. */
export const cloneFabricOnly = (prev: SaleLine): Partial<SaleLine> => ({
  fabricId: prev.fabricId,
  fabricName: prev.fabricName,
  // Color and roll intentionally left empty
  colorId: "",
  colorName: "",
  colorCode: "",
  rollId: "",
  // Preserve pricing (user can change per color if needed)
  pricePerKg: prev.pricePerKg,
  discountAmount: prev.discountAmount,
  pieces: prev.pieces,
});

export const lineHasData = (l: SaleLine) =>
  l.fabricName.trim() !== "" || l.rollId !== "" || l.quantityKg > 0;

export const lineGross = (l: SaleLine) => (l.quantityKg || 0) * (l.pricePerKg || 0);

// FIN-01: delegates to the single money authority so the on-screen line total
// uses the same 2dp rounding as the journaled subtotal. Guards against a
// missing/zero quantity or price while the operator is still typing.
export const lineTotal = (l: SaleLine) =>
  sharedLineTotal({
    quantityKg: l.quantityKg || 0,
    pricePerKg: l.pricePerKg || 0,
    discountAmount: l.discountAmount || 0,
  } as InvoiceLineData);
