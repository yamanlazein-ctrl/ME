/**
 * The cash actually in hand, expressed as profit.
 *
 * An invoice is only partly settled, so only the collected part carries the
 * margin: `min(paid, total) × (grossProfit / total)`. On the owner's own
 * figures — 490 invoiced, 120 paid, 52.50 gross — that is 12.86, not the 52.50
 * the books show. A zero-value invoice has no margin to apportion.
 */
export function cashProfitCollected(total: number, paid: number, grossProfit: number): number {
  if (!(total > 0)) return 0;
  const cashCollected = Math.min(paid, total);
  return cashCollected * (grossProfit / total);
}
