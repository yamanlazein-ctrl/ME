/**
 * Bulk-delete planning for the inventory page.
 *
 * Deleting a fabric (dye) is a financial operation: it can cascade into invoices, vouchers, ledger
 * entries and the cashbox. The page therefore never deletes fabrics itself — it only decides WHICH
 * fabrics are queued for the confirmation dialog (`DyePurgeDialog`), one at a time, so each one gets
 * its own impact sheet, typed confirmation and hub-only guidance. Colours and rolls keep the plain
 * delete (their own cascade is the repository's).
 */
export type BulkItem = { kind: "fabric" | "color" | "roll"; id: string; name: string };

export type BulkPlan = {
  /** Fabrics to confirm one by one through `DyePurgeDialog`. */
  fabrics: { id: string; name: string }[];
  /** Colours not already covered by a selected fabric. */
  colorIds: string[];
  /** Rolls not already covered by a selected fabric or colour. */
  rollIds: string[];
};

export function planBulkDelete(
  items: readonly BulkItem[],
  lookup: {
    colorFabricId: (colorId: string) => string | undefined;
    rollColorId: (rollId: string) => string | undefined;
  },
): BulkPlan {
  const fabrics = items.filter((i) => i.kind === "fabric").map((i) => ({ id: i.id, name: i.name }));
  const fabricSet = new Set(fabrics.map((f) => f.id));

  const colorIds = items
    .filter((i) => i.kind === "color")
    .filter((i) => {
      const f = lookup.colorFabricId(i.id);
      return !(f && fabricSet.has(f));
    })
    .map((i) => i.id);
  const colorSet = new Set(colorIds);

  const rollIds = items
    .filter((i) => i.kind === "roll")
    .filter((i) => {
      const colorId = lookup.rollColorId(i.id);
      if (!colorId) return true;
      const f = lookup.colorFabricId(colorId);
      if (f && fabricSet.has(f)) return false;
      return !colorSet.has(colorId);
    })
    .map((i) => i.id);

  return { fabrics, colorIds, rollIds };
}
