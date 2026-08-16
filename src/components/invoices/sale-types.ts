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
});

export const cloneStickyFields = (prev: SaleLine): Partial<SaleLine> => ({
  fabricId: prev.fabricId,
  fabricName: prev.fabricName,
  colorId: prev.colorId,
  colorName: prev.colorName,
  colorCode: prev.colorCode,
  pricePerKg: prev.pricePerKg,
  discountAmount: prev.discountAmount,
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
});

export const lineHasData = (l: SaleLine) =>
  l.fabricName.trim() !== "" || l.rollId !== "" || l.quantityKg > 0;

export const lineGross = (l: SaleLine) => (l.quantityKg || 0) * (l.pricePerKg || 0);
export const lineTotal = (l: SaleLine) => {
  const gross = lineGross(l);
  // Fixed-amount (not percentage) line discount. Guards against a missing/zero
  // quantity or price so a discounted line never yields NaN or a negative/sub-zero
  // total while the operator is still typing.
  return Math.max(0, gross - (l.discountAmount || 0));
};
