/**
 * Color names are shared across fabrics; stock rows stay per-fabric
 * (`colors.fabric_id`). Search may list "زيتي" from cotton while the line is
 * Turkish jeans — callers must never bind that other fabric's id.
 */

import { normalizeInventoryName } from "./normalizeInventoryName";

export type ColorLookupRow = {
  id: string;
  fabricId: string;
  name: string;
  code?: string | null;
  hex?: string | null;
  imageUrl?: string | null;
};

export function filterColorsByQuery<
  T extends { name: string; code?: string | null; fabricId?: string },
>(catalog: T[], term: string, limit = 12, fabricId?: string): T[] {
  const pool = fabricId ? catalog.filter((c) => c.fabricId === fabricId) : catalog;
  const q = normalizeInventoryName(term);
  // Scoped to a fabric: empty query lists that fabric's colours (sale/entry pickers).
  // Unscoped: never dump the whole catalogue.
  if (!q) return fabricId ? pool.slice(0, limit) : [];
  const scored = pool
    .map((c) => {
      const code = normalizeInventoryName(c.code ?? "");
      const name = normalizeInventoryName(c.name ?? "");
      if (code === q) return { c, score: 0 };
      if (name === q) return { c, score: 1 };
      if (code.startsWith(q)) return { c, score: 2 };
      if (name.startsWith(q)) return { c, score: 3 };
      if (code.includes(q) || name.includes(q)) return { c, score: 4 };
      return null;
    })
    .filter((x): x is { c: T; score: number } => x !== null)
    .sort((a, b) => a.score - b.score);
  return scored.slice(0, limit).map((x) => x.c);
}

export function colorOnFabric<T extends ColorLookupRow>(
  catalog: T[],
  fabricId: string | undefined,
  opts: { name?: string; code?: string },
): T | undefined {
  if (!fabricId) return undefined;
  const code = opts.code ? normalizeInventoryName(opts.code) : "";
  const name = opts.name ? normalizeInventoryName(opts.name) : "";
  if (code) {
    const byCode = catalog.find(
      (c) => c.fabricId === fabricId && normalizeInventoryName(c.code ?? "") === code,
    );
    if (byCode) return byCode;
  }
  if (name) {
    return catalog.find((c) => c.fabricId === fabricId && normalizeInventoryName(c.name) === name);
  }
  return undefined;
}

export type ResolvedColorPick = {
  existingColorId?: string;
  colorName: string;
  colorCode: string;
  hex?: string;
  imageUrl?: string;
  /** True when the picked row belongs to another fabric — save must create/link locally. */
  crossFabric: boolean;
};

export function resolveColorPick<T extends ColorLookupRow>(
  picked: T,
  targetFabricId: string | undefined,
  catalog: T[],
): ResolvedColorPick {
  const base = {
    colorName: picked.name,
    colorCode: picked.code ?? "",
    hex: picked.hex ?? undefined,
    imageUrl: picked.imageUrl ?? undefined,
  };
  if (targetFabricId && picked.fabricId === targetFabricId) {
    return { ...base, existingColorId: picked.id, crossFabric: false };
  }
  if (targetFabricId) {
    const local = colorOnFabric(catalog, targetFabricId, { name: picked.name });
    if (local) {
      return {
        colorName: local.name,
        colorCode: local.code ?? "",
        hex: local.hex ?? undefined,
        imageUrl: local.imageUrl ?? undefined,
        existingColorId: local.id,
        crossFabric: false,
      };
    }
  }
  return { ...base, existingColorId: undefined, crossFabric: true };
}
