export type RollInfo = {
  id: string;
  remainingKg: number;
  colorId: string;
};

export type ColorInfo = {
  id: string;
  fabricId: string;
  name: string;
};

export type FabricInfo = {
  id: string;
  name: string;
};

export type OrderItemForMatching = {
  fabricId?: string;
  fabricName: string;
  colorId?: string;
  colorName: string;
  requestedKg: number;
};

export type RollMatch = {
  rollIds: string[];
  availableKg: number;
};

export function matchRollsForItem(
  item: OrderItemForMatching,
  rolls: RollInfo[],
  colors: ColorInfo[],
  fabrics: FabricInfo[],
): RollMatch {
  const colorMap = new Map<string, ColorInfo>();
  for (const c of colors) colorMap.set(c.id, c);
  const fabricMap = new Map<string, FabricInfo>();
  for (const f of fabrics) fabricMap.set(f.id, f);

  const matches = rolls.filter((r) => {
    if (r.remainingKg <= 0) return false;
    const c = colorMap.get(r.colorId);
    if (!c) return false;
    if (item.fabricId && item.colorId) {
      return c.fabricId === item.fabricId && c.id === item.colorId;
    }
    if (item.fabricId) {
      return (
        c.fabricId === item.fabricId &&
        c.name.trim().toLowerCase() === item.colorName.trim().toLowerCase()
      );
    }
    const f = fabricMap.get(c.fabricId);
    if (!f) return false;
    return (
      f.name.trim().toLowerCase() === item.fabricName.trim().toLowerCase() &&
      c.name.trim().toLowerCase() === item.colorName.trim().toLowerCase()
    );
  });
  return {
    rollIds: matches.map((r) => r.id),
    availableKg: matches.reduce((s, r) => s + r.remainingKg, 0),
  };
}

export type OrderAvailability = "none" | "partial" | "full";

export function computeOrderAvailability(
  items: OrderItemForMatching[],
  rolls: RollInfo[],
  colors: ColorInfo[],
  fabrics: FabricInfo[],
): OrderAvailability {
  let fullCount = 0;
  let anyMatch = false;
  for (const it of items) {
    const m = matchRollsForItem(it, rolls, colors, fabrics);
    if (m.availableKg > 0) anyMatch = true;
    if (m.availableKg >= it.requestedKg && it.requestedKg > 0) fullCount++;
  }
  if (fullCount === items.length && items.length > 0) return "full";
  if (anyMatch) return "partial";
  return "none";
}

export function decrementRollKg(roll: RollInfo, kg: number): number {
  return Math.max(0, roll.remainingKg - kg);
}

export function incrementRollKg(roll: RollInfo, kg: number, initialKg?: number): number {
  const next = roll.remainingKg + kg;
  const cap = initialKg ?? roll.remainingKg;
  if (next > cap) return cap;
  return next;
}
