/**
 * Sale-line unit cost is frozen at first capture (create, or first time a
 * roll appears on this invoice). Later roll.pricePerKg changes must not
 * revalue historical COGS or replayed edits.
 */
export function resolveSaleCostPerKg(
  historicalCostPerKg: number | null | undefined,
  currentRollPricePerKg: number,
): number {
  if (historicalCostPerKg != null && Number.isFinite(historicalCostPerKg)) {
    return historicalCostPerKg;
  }
  return currentRollPricePerKg;
}
